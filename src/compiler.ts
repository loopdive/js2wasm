import ts from "typescript";
import {
  analyzeFiles,
  analyzeMultiSource,
  analyzeSource,
  IncrementalLanguageService,
  type TypedAST,
} from "./checker/index.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import { resetCompileDepth } from "./codegen/expressions.js";
import { generateLinearModule, generateLinearMultiModule } from "./codegen-linear/index.js";
import {
  emitBinary,
  emitBinaryWithSourceMap,
  emitSourceMappingURLSection,
} from "./emit/binary.js";
import { WasmEncoder } from "./emit/encoder.js";
import { emitObject } from "./emit/object.js";
import { generateSourceMap } from "./emit/sourcemap.js";
import { emitWat } from "./emit/wat.js";
import { preprocessImports } from "./import-resolver.js";
import type { CompileError, CompileOptions, CompileResult, ImportDescriptor, ImportIntent } from "./index.js";
import { optimizeBinary } from "./optimize.js";
import type { WasmModule, FuncTypeDef, ValType, Instr } from "./ir/types.js";
import { generateCHeader, extractCHeaderExports } from "./emit/c-header.js";
import type { CabiExportInfo, CabiParam, ParamDef } from "./codegen-linear/c-abi.js";
import { mapParamsToCabi, mapResultToCabi, emitCabiWrappers, inferSemantic } from "./codegen-linear/c-abi.js";
import { generateWit } from "./wit-generator.js";

// Default blocked members on extern classes in safe mode
const DEFAULT_BLOCKED_MEMBERS = new Set([
  "__proto__", "constructor", "prototype", "valueOf", "toString",
  "innerHTML", "outerHTML", "insertAdjacentHTML",
]);

/** Validate source against safe mode restrictions. Returns errors for violations. */
function validateSafeMode(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: CompileOptions,
): CompileError[] {
  const errors: CompileError[] = [];
  const allowedGlobals = new Set(options.allowedGlobals ?? []);
  const allowedMembers = options.allowedExternMembers ?? {};

  function pos(node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function visit(node: ts.Node): void {
    // 1. Check declare var/const globals
    if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText();
        // Block undeclared globals unless allowlisted
        if (!allowedGlobals.has(name)) {
          const p = pos(decl);
          errors.push({
            message: `Safe mode: declared global "${name}" is not in allowedGlobals`,
            line: p.line, column: p.column, severity: "error",
          });
        }
        // Block any type on declared globals
        if (decl.type) {
          const t = checker.getTypeAtLocation(decl.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(decl.type);
            errors.push({
              message: `Safe mode: "any" type on declared global "${name}" is not allowed`,
              line: p.line, column: p.column, severity: "error",
            });
          }
        }
      }
    }

    // 2. Check declare class (extern class) members
    if (ts.isClassDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      const className = node.name?.getText() ?? "(anonymous)";
      const allowed = allowedMembers[className];
      for (const member of node.members) {
        const memberName = member.name?.getText();
        if (!memberName) continue;

        // Block default-blocked members
        if (DEFAULT_BLOCKED_MEMBERS.has(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is blocked`,
            line: p.line, column: p.column, severity: "error",
          });
          continue;
        }

        // If an allowlist is provided for this class, check against it
        if (allowed && !allowed.includes(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is not in allowedExternMembers`,
            line: p.line, column: p.column, severity: "error",
          });
          continue;
        }

        // Block "any" types on extern class members
        if (ts.isPropertyDeclaration(member) && member.type) {
          const t = checker.getTypeAtLocation(member.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(member.type);
            errors.push({
              message: `Safe mode: "any" type on extern class "${className}.${memberName}" is not allowed`,
              line: p.line, column: p.column, severity: "error",
            });
          }
        }
      }
    }

    // 3. Check for dynamic property access on externref (element access with non-literal)
    if (ts.isElementAccessExpression(node)) {
      const objType = checker.getTypeAtLocation(node.expression);
      // If the object is an extern class type (declared class), block dynamic access
      const objSymbol = objType.getSymbol();
      if (objSymbol) {
        const decls = objSymbol.getDeclarations() ?? [];
        const isDeclaredClass = decls.some(d =>
          ts.isClassDeclaration(d) && d.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)
        );
        if (isDeclaredClass) {
          const p = pos(node);
          errors.push({
            message: `Safe mode: dynamic property access on extern class "${objSymbol.getName()}" is not allowed`,
            line: p.line, column: p.column, severity: "error",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

/**
 * Detect ECMAScript early errors that TypeScript's parser is too permissive about.
 * These are patterns that should be SyntaxErrors per the ES spec but TypeScript
 * accepts (especially in allowJs mode or with certain diagnostic codes downgraded).
 *
 * This pass walks the AST and produces compile errors for:
 * 1. Strict mode assignment to arguments/eval (prefix/postfix/assignment)
 * 2. Duplicate parameter names in strict mode functions
 * 3. yield/await used as identifiers in generator/async functions
 * 4. Invalid assignment targets (parenthesized non-simple expressions)
 */
function detectEarlyErrors(
  sourceFile: ts.SourceFile,
): CompileError[] {
  const errors: CompileError[] = [];

  function pos(node: ts.Node): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function addError(node: ts.Node, message: string) {
    const p = pos(node);
    errors.push({ message, line: p.line, column: p.column, severity: "error" });
  }

  /**
   * Check if a node is in strict mode context.
   * A node is in strict mode if:
   * - The source file has "use strict" directive
   * - It's inside a class body (class bodies are always strict)
   * - It's inside a function with "use strict" directive
   * - The source is a module (has import/export — but we add "export {}" so all are modules)
   */
  function isStrictMode(node: ts.Node): boolean {
    // Check for "use strict" directives and class context
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isSourceFile(current)) {
        // Check for "use strict" directive at file level
        for (const stmt of current.statements) {
          if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
            if (stmt.expression.text === "use strict") return true;
          } else {
            break; // Directives must be at the top
          }
        }
        // Don't assume module = strict. We add `export {}` synthetically for TS,
        // but the source may be a sloppy-mode script (test262 noStrict tests).
        return false;
      }
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
        return true;
      }
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) {
        // Check for "use strict" directive in function body
        if (current.body && ts.isBlock(current.body)) {
          for (const stmt of current.body.statements) {
            if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
              if (stmt.expression.text === "use strict") return true;
            } else {
              break; // Directives must be at the top
            }
          }
        }
      }
      current = current.parent;
    }
    return false;
  }

  function isArgumentsOrEval(node: ts.Node): string | null {
    if (ts.isIdentifier(node)) {
      if (node.text === "arguments" || node.text === "eval") {
        return node.text;
      }
    }
    // Also check parenthesized: (arguments), ((eval))
    if (ts.isParenthesizedExpression(node)) {
      return isArgumentsOrEval(node.expression);
    }
    return null;
  }

  /**
   * Check if an expression is a "simple assignment target" per ES spec.
   * Only identifiers and property accesses are valid assignment targets.
   */
  function isSimpleAssignmentTarget(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return true;
    if (ts.isPropertyAccessExpression(node)) return true;
    if (ts.isElementAccessExpression(node)) return true;
    if (ts.isParenthesizedExpression(node)) {
      return isSimpleAssignmentTarget(node.expression);
    }
    return false;
  }

  /** Collect binding names and report duplicates. */
  function collectBindingNamesWithDuplicateCheck(name: ts.BindingName, out: Set<string>, dupes: Set<string>): void {
    if (ts.isIdentifier(name)) {
      if (out.has(name.text)) dupes.add(name.text);
      out.add(name.text);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        collectBindingNamesWithDuplicateCheck(el.name, out, dupes);
      }
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) {
          collectBindingNamesWithDuplicateCheck(el.name, out, dupes);
        }
      }
    }
  }

  /** Collect all identifier names from a binding pattern (identifier, array, object destructuring). */
  function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
    if (ts.isIdentifier(name)) {
      out.add(name.text);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        collectBindingNames(el.name, out);
      }
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) {
          collectBindingNames(el.name, out);
        }
      }
    }
  }

  function checkDuplicateParams(params: ts.NodeArray<ts.ParameterDeclaration>, node: ts.Node) {
    // ES spec: Duplicate params are always forbidden in:
    // - strict mode functions
    // - arrow functions
    // - async functions
    // - generator functions
    // - methods
    // - functions with non-simple parameter lists (default, rest, destructuring)
    const alwaysForbid =
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
        (node.asteriskToken !== undefined ||
         node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))) ||
      params.some(p => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name));
    if (!alwaysForbid && !isStrictMode(node)) return;
    const seen = new Set<string>();
    for (const param of params) {
      const names = new Set<string>();
      collectBindingNames(param.name, names);
      for (const name of names) {
        if (seen.has(name)) {
          addError(param, `Duplicate parameter name '${name}' not allowed`);
        }
        seen.add(name);
      }
    }
  }

  /**
   * Check if an expression is an "invalid" assignment target per ES spec.
   * Invalid targets include: `this`, `new.target`, literals, arrow functions,
   * template literals, class expressions, etc.
   */
  function isInvalidAssignmentTarget(node: ts.Expression): boolean {
    let expr: ts.Node = node;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    // this
    if (expr.kind === ts.SyntaxKind.ThisKeyword) return true;
    // Literals (numbers, strings, booleans, null, regex, template)
    if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr) ||
        ts.isRegularExpressionLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ||
        ts.isTemplateExpression(expr) || ts.isTaggedTemplateExpression(expr) ||
        expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword ||
        expr.kind === ts.SyntaxKind.NullKeyword) return true;
    // Arrow functions, function expressions, class expressions
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) return true;
    // new.target (MetaProperty)
    if (ts.isMetaProperty(expr)) return true;
    return false;
  }

  /**
   * Check if an expression is a call expression (not a valid simple assignment target).
   * CallExpression assignment targets are SyntaxErrors in strict mode per ES spec.
   */
  function isCallExpressionTarget(node: ts.Node): boolean {
    let expr: ts.Node = node;
    while (ts.isParenthesizedExpression(expr)) expr = (expr as ts.ParenthesizedExpression).expression;
    return ts.isCallExpression(expr);
  }

  /** Check if an expression involves optional chaining (?.) */
  function hasOptionalChain(node: ts.Expression): boolean {
    let expr: ts.Node = node;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    // TS models optional chains with questionDotToken
    if ((ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr) ||
         ts.isCallExpression(expr)) && (expr as any).questionDotToken) {
      return true;
    }
    // Check parent chain for optional chaining context
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      return hasOptionalChain(expr.expression);
    }
    return false;
  }

  function visit(node: ts.Node): void {
    // Check prefix/postfix increment/decrement on arguments/eval in strict mode
    // Also check increment/decrement on optional chaining (always invalid)
    // Also check increment/decrement on non-simple assignment targets
    if (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const name = isArgumentsOrEval(node.operand);
      if (name && isStrictMode(node)) {
        addError(node, `Invalid use of '${name}' in strict mode`);
      }
      if (hasOptionalChain(node.operand)) {
        addError(node, "Optional chaining is not valid in the left-hand side of an update expression");
      }
      if (isInvalidAssignmentTarget(node.operand)) {
        addError(node, "Invalid left-hand side expression in prefix operation");
      }
      // In strict mode, call expressions as update targets are SyntaxErrors
      if (isCallExpressionTarget(node.operand) && isStrictMode(node)) {
        addError(node, "Invalid left-hand side expression in prefix operation");
      }
    }

    if (ts.isPostfixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const name = isArgumentsOrEval(node.operand);
      if (name && isStrictMode(node)) {
        addError(node, `Invalid use of '${name}' in strict mode`);
      }
      if (hasOptionalChain(node.operand)) {
        addError(node, "Optional chaining is not valid in the left-hand side of an update expression");
      }
      if (isInvalidAssignmentTarget(node.operand)) {
        addError(node, "Invalid left-hand side in postfix operation");
      }
      // In strict mode, call expressions as update targets are SyntaxErrors
      if (isCallExpressionTarget(node.operand) && isStrictMode(node)) {
        addError(node, "Invalid left-hand side in postfix operation");
      }
    }

    // Check assignment to arguments/eval in strict mode
    // Also check assignment to non-simple targets
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = isArgumentsOrEval(node.left);
      if (name && isStrictMode(node)) {
        addError(node.left, `Cannot assign to '${name}' in strict mode`);
      }
      if (isInvalidAssignmentTarget(node.left)) {
        addError(node, "Invalid left-hand side in assignment");
      }
    }

    // Check compound assignment to arguments/eval in strict mode
    // Also check logical assignment (&&=, ||=, ??=) to non-simple targets
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const compoundOps = [
        ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
        ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
        ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
        ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.AsteriskAsteriskEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ];
      if (compoundOps.includes(op)) {
        const name = isArgumentsOrEval(node.left);
        if (name && isStrictMode(node)) {
          addError(node.left, `Cannot assign to '${name}' in strict mode`);
        }
        // Check logical/compound assignment to call expressions in strict mode
        if (isCallExpressionTarget(node.left) && isStrictMode(node)) {
          addError(node, "Invalid left-hand side in assignment");
        }
      }
    }

    // Check for-in/for-of with call expression as LHS in strict mode
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)) {
      if (isCallExpressionTarget(node.initializer) && isStrictMode(node)) {
        addError(node.initializer, "Invalid left-hand side in for-in/for-of");
      }
    }

    // Check duplicate parameters in strict mode functions
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      checkDuplicateParams(node.parameters, node);
    }
    if (ts.isFunctionExpression(node) && node.parameters) {
      checkDuplicateParams(node.parameters, node);
    }
    if (ts.isArrowFunction(node) && node.parameters) {
      checkDuplicateParams(node.parameters, node);
    }
    if (ts.isMethodDeclaration(node) && node.parameters) {
      checkDuplicateParams(node.parameters, node);
    }

    // Check yield used as identifier in generator functions
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "yield") {
      // Check if inside a generator function
      let parent: ts.Node | undefined = node.parent;
      while (parent) {
        if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) &&
            parent.asteriskToken) {
          addError(node.name, "'yield' is a reserved word and cannot be used as an identifier in generator functions");
          break;
        }
        if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
            ts.isArrowFunction(parent) || ts.isMethodDeclaration(parent)) {
          break; // Found enclosing non-generator function, stop
        }
        parent = parent.parent;
      }
    }

    // Check function declarations in statement position
    // ES spec: GeneratorDeclaration and AsyncFunctionDeclaration are never valid in
    // SingleStatement position. Regular FunctionDeclaration is SyntaxError in strict mode.
    // Annex B relaxes this ONLY for IfStatement in sloppy mode — iteration statements
    // (for, while, do, for-in, for-of) and with statements always forbid it.
    if (ts.isFunctionDeclaration(node)) {
      const parent = node.parent;
      if (parent && isStatementPosition(parent, node)) {
        if (node.asteriskToken) {
          addError(node, "Generator declarations are not allowed in statement position");
        } else if (hasAsyncModifier(node)) {
          addError(node, "Async function declarations are not allowed in statement position");
        } else if (isStrictMode(node)) {
          addError(node, "In strict mode code, functions can only be declared at top level or inside a block");
        } else if (!ts.isIfStatement(parent) && !ts.isLabeledStatement(parent)) {
          // Sloppy mode: Annex B only allows FunctionDeclaration in IfStatement body.
          // In iteration statements (for, while, do, for-in, for-of) and with statements
          // it is always a SyntaxError.
          addError(node, "Function declarations are not allowed in statement position");
        }
      }
    }

    // Check class declaration in statement position — always a SyntaxError
    // ES spec: ClassDeclaration is not a Statement — only allowed in StatementList
    if (ts.isClassDeclaration(node)) {
      const parent = node.parent;
      if (parent && isStatementPosition(parent, node)) {
        addError(node, "Class declaration not allowed in statement position");
      }
    }

    // Check labeled function declarations in iteration/if statement positions
    // ES spec: IsLabelledFunction — a labeled function declaration (at any label depth)
    // in the Statement position of for/while/do-while/if/with is always a SyntaxError.
    if (ts.isLabeledStatement(node)) {
      const parent = node.parent;
      if (parent && isStatementPosition(parent, node)) {
        // Check if the innermost statement (through label nesting) is a function/class declaration
        let inner: ts.Statement = node.statement;
        while (ts.isLabeledStatement(inner)) inner = inner.statement;
        if (ts.isFunctionDeclaration(inner)) {
          addError(node, "Function declaration in a labeled statement within iteration/if body is a SyntaxError");
        }
        if (ts.isClassDeclaration(inner)) {
          addError(node, "Class declaration not allowed in statement position");
        }
      }
    }

    // Check private name (#x) used outside its declaring class
    if (ts.isPrivateIdentifier(node)) {
      if (!isInsideClassWithPrivateName(node, node.escapedText as string)) {
        addError(node, `Private field '${node.text}' must be declared in an enclosing class`);
      }
    }

    // Check var redeclaration conflicts with lexical declarations in block scope
    // ES spec: It is a Syntax Error if any element of VarDeclaredNames also occurs
    // in LexicallyDeclaredNames of the StatementList.
    if (ts.isBlock(node)) {
      checkVarLexicalConflicts(node);
    }

    // Check TDZ violations for let/const in block-like scopes
    // These are also caught by TS checker (2448/2474) as downgraded warnings.
    // We emit them as warnings here so compilation continues — tests expect runtime ReferenceError.
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const stmts = ts.isSourceFile(node) ? node.statements :
                    ts.isBlock(node) ? node.statements :
                    node.statements;
      checkTDZInStatements(stmts);
    }

    // Check 'with' statement — SyntaxError in strict mode (all modules are strict)
    if (ts.isWithStatement(node) && isStrictMode(node)) {
      addError(node, "Strict mode code may not include a with statement");
    }

    // Check legacy octal literals (e.g. 077) and non-octal decimal integers (e.g. 08, 09)
    // — SyntaxError in strict mode
    // ES2015+ octal (0o77) is fine; only legacy forms are illegal
    if (ts.isNumericLiteral(node) && isStrictMode(node)) {
      const text = node.getText(sourceFile);
      // Legacy octal: starts with 0, followed by digits 0-7
      if (/^0[0-7]+$/.test(text) && text.length > 1) {
        addError(node, "Octal literals are not allowed in strict mode");
      }
      // Non-octal decimal integer: starts with 0, followed by digits 0-9 (containing 8 or 9)
      // e.g. 08, 09, 089 — these are "NonOctalDecimalIntegerLiteral" per ES spec
      if (/^0\d+$/.test(text) && text.length > 1 && !/^0[oOxXbB]/.test(text)) {
        if (/[89]/.test(text)) {
          addError(node, "Decimals with leading zeros are not allowed in strict mode");
        }
      }
    }

    // Check 'delete' of an unqualified identifier — SyntaxError in strict mode
    if (ts.isDeleteExpression(node) && isStrictMode(node)) {
      let operand = node.expression;
      while (ts.isParenthesizedExpression(operand)) {
        operand = operand.expression;
      }
      if (ts.isIdentifier(operand)) {
        addError(node, `Delete of an unqualified identifier in strict mode`);
      }
    }

    // Check for-in loop with initializer — SyntaxError in strict mode for var,
    // always a SyntaxError for let/const (ES2015+)
    // Also: var with destructuring pattern + initializer is always SyntaxError (Annex B)
    if (ts.isForInStatement(node)) {
      const init = node.initializer;
      if (ts.isVariableDeclarationList(init)) {
        const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
        for (const decl of init.declarations) {
          if (decl.initializer) {
            const hasDestructuring = !ts.isIdentifier(decl.name);
            if (isLexical || isStrictMode(node) || hasDestructuring) {
              addError(node, "for-in loop head declarations may not have initializers");
              break;
            }
          }
        }
        // for-in/for-of with multiple lexical bindings is always a SyntaxError
        if (isLexical && init.declarations.length > 1) {
          addError(node, "Only a single declaration is allowed in a for-in statement");
        }
      }
    }

    // Check for-of loop: lexical declarations may not have initializers or multiple bindings
    if (ts.isForOfStatement(node)) {
      const init = node.initializer;
      if (ts.isVariableDeclarationList(init)) {
        const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
        if (isLexical) {
          for (const decl of init.declarations) {
            if (decl.initializer) {
              addError(node, "for-of loop head declarations may not have initializers");
              break;
            }
          }
          if (init.declarations.length > 1) {
            addError(node, "Only a single declaration is allowed in a for-of statement");
          }
        }
      }
    }

    // Check labeled function declarations in strict mode
    // e.g. label: function f() {} is a SyntaxError in strict mode
    if (ts.isLabeledStatement(node) && isStrictMode(node)) {
      if (ts.isFunctionDeclaration(node.statement)) {
        addError(node, "In strict mode code, functions can only be declared at top level or inside a block");
      }
    }

    // ── Rest element early errors ──────────────────────────────────────
    // ES spec: Rest element cannot have an initializer (default value).
    // e.g. function f(...a = []) {}, const [...a = []] = arr;
    if (ts.isParameter(node) && node.dotDotDotToken && node.initializer) {
      addError(node, "Rest parameter may not have a default initializer");
    }
    if (ts.isBindingElement(node) && node.dotDotDotToken && node.initializer) {
      addError(node, "Rest element may not have a default initializer");
    }

    // ES spec: Rest element must be last — no trailing elements after rest.
    // e.g. const [...a, b] = arr;  function f(...a, b) {}
    if (ts.isArrayBindingPattern(node)) {
      let foundRest = false;
      for (const element of node.elements) {
        if (foundRest) {
          addError(element, "A rest element must be last in a destructuring pattern");
          break;
        }
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          foundRest = true;
        }
      }
    }

    // ES spec: Trailing comma after rest parameter is a SyntaxError.
    // e.g. function f(...a,) {}
    // TypeScript's parser accepts this, but ES spec forbids it.
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
         ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
         ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
         ts.isSetAccessorDeclaration(node)) && node.parameters.length > 0) {
      const lastParam = node.parameters[node.parameters.length - 1]!;
      if (lastParam.dotDotDotToken) {
        // Check if there's a trailing comma after the rest parameter.
        // The trailing comma is indicated by a comma after the last parameter
        // in the source text.
        const paramEnd = lastParam.end;
        const parenClose = node.parameters.end; // end of the parameter list
        const textBetween = sourceFile.text.substring(paramEnd, parenClose);
        if (textBetween.includes(",")) {
          addError(lastParam, "A rest parameter or binding pattern may not have a trailing comma");
        }
      }
    }

    // ── await/yield as identifier in async/generator contexts ──────────
    // ES spec: 'await' is a reserved word inside async functions/generators.
    // 'yield' is a reserved word inside generator functions.
    if (ts.isIdentifier(node) && (node.text === "await" || node.text === "yield")) {
      // Skip if this is the yield/await *expression* (keyword usage, not identifier)
      const parent = node.parent;
      if (parent && !ts.isYieldExpression(parent) && !ts.isAwaitExpression(parent)) {
        // Skip if this is a property name in a member expression or declaration
        const isPropertyName = parent && (
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isEnumMember(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node)
        );
        if (!isPropertyName) {
          if (node.text === "await" && isInsideAsyncFunction(node)) {
            addError(node, "'await' is not allowed as an identifier in an async function");
          }
          if (node.text === "yield" && isInsideGeneratorFunction(node)) {
            addError(node, "'yield' is not allowed as an identifier in a generator function");
          }
        }
      }
    }

    // ── Strict mode reserved words as identifiers ──────────────────────
    // ES spec: implements, interface, let, package, private, protected,
    // public, static, yield are reserved in strict mode.
    if (ts.isIdentifier(node) && isStrictMode(node)) {
      const strictReserved = new Set([
        "implements", "interface", "package", "private", "protected", "public", "static",
      ]);
      if (strictReserved.has(node.text)) {
        // Skip property names — they're fine in strict mode
        const parent = node.parent;
        const isPropertyName = parent && (
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyDeclaration(parent) && parent.name === node) ||
          (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node)
        );
        // Also skip if used as a label name (label: statement)
        const isLabel = parent && ts.isLabeledStatement(parent) && parent.label === node;
        // Skip break/continue target labels
        const isBreakContinueTarget = parent && (
          (ts.isBreakStatement(parent) && parent.label === node) ||
          (ts.isContinueStatement(parent) && parent.label === node)
        );
        if (!isPropertyName && !isLabel && !isBreakContinueTarget) {
          // Flag when used as a binding name (variable, parameter, function name)
          // or as a shorthand property (IdentifierReference context)
          const isBinding = parent && (
            (ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isParameter(parent) && parent.name === node) ||
            (ts.isFunctionDeclaration(parent) && parent.name === node) ||
            (ts.isFunctionExpression(parent) && parent.name === node) ||
            (ts.isClassDeclaration(parent) && parent.name === node) ||
            (ts.isClassExpression(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) && parent.name === node) ||
            // Shorthand property in object literal: {implements} — IdentifierReference
            (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
          );
          if (isBinding) {
            addError(node, `'${node.text}' is a reserved word in strict mode and cannot be used as an identifier`);
          }
        }
      }
    }

    // ── "use strict" + non-simple parameters ─────────────────────────
    // ES spec: It is a SyntaxError if ContainsUseStrict of FunctionBody is true
    // and IsSimpleParameterList of FormalParameters is false.
    // Non-simple: default values, destructuring patterns, or rest parameters.
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
         ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
         ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
         ts.isSetAccessorDeclaration(node)) && node.body && ts.isBlock(node.body)) {
      const hasNonSimpleParams = node.parameters.some(p =>
        p.initializer !== undefined ||
        p.dotDotDotToken !== undefined ||
        !ts.isIdentifier(p.name) // destructuring pattern
      );
      if (hasNonSimpleParams) {
        // Check if body starts with "use strict" directive
        for (const stmt of node.body.statements) {
          if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
            if (stmt.expression.text === "use strict") {
              addError(stmt, "Illegal 'use strict' directive in function with non-simple parameter list");
              break;
            }
          } else {
            break; // Directives must be at the top
          }
        }
      }
    }

    // ── Parameter names conflicting with lexical body declarations ─────
    // ES spec: It is a SyntaxError if BoundNames of FormalParameters also
    // occurs in the LexicallyDeclaredNames of FunctionBody (for arrow,
    // async, generator, method, constructor, getter, setter).
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
         ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
         ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
         ts.isSetAccessorDeclaration(node)) && node.body && ts.isBlock(node.body)) {
      const paramNames = new Set<string>();
      for (const p of node.parameters) {
        collectBindingNames(p.name, paramNames);
      }
      if (paramNames.size > 0) {
        for (const stmt of node.body.statements) {
          if (ts.isVariableStatement(stmt)) {
            const flags = stmt.declarationList.flags;
            if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
              for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && paramNames.has(decl.name.text)) {
                  addError(decl.name, `Duplicate identifier '${decl.name.text}' — parameter and lexical declaration`);
                }
              }
            }
          }
        }
      }
    }

    // ── Labeled declarations (not function declarations) ──────────────
    // ES spec: LabelledItem only allows Statement or FunctionDeclaration.
    // LexicalDeclarations (let, const), class declarations, async generators,
    // and async functions in labeled position are SyntaxErrors.
    if (ts.isLabeledStatement(node)) {
      const stmt = node.statement;
      // label: let x; or label: const x;
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
          addError(node, "Lexical declaration (let/const) cannot appear in a labeled statement");
        }
      }
      // label: class C {} — always a SyntaxError
      if (ts.isClassDeclaration(stmt)) {
        addError(node, "Class declaration cannot appear in a labeled statement");
      }
    }

    // ── let/const in single-statement positions ──────────────────────
    // ES spec: LetOrConst is not allowed in the Statement position of
    // if, else, while, do-while, for bodies.
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
        const parent = node.parent;
        if (parent && isStatementPosition(parent, node)) {
          addError(node, "Lexical declaration cannot appear in a single-statement context");
        }
      }
    }

    // ── const without initializer ──────────────────────────────────
    // ES spec: LexicalBinding for `const` must have an Initializer.
    // Exception: `for (const x of ...)` and `for (const x in ...)` — the
    // variable gets its value from the iterable/object, not an initializer.
    if (ts.isVariableDeclaration(node) && !node.initializer) {
      const declList = node.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        const declListParent = declList.parent;
        const isForOfOrIn = declListParent && (
          ts.isForOfStatement(declListParent) || ts.isForInStatement(declListParent)
        );
        if (!isForOfOrIn) {
          addError(node, "Missing initializer in const declaration");
        }
      }
    }

    // ── 'let' as binding name in lexical declarations ──────────────
    // ES spec: It is a SyntaxError if BoundNames of LetOrConst contains "let".
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "let") {
      const declList = node.parent;
      if (ts.isVariableDeclarationList(declList)) {
        if ((declList.flags & ts.NodeFlags.Let) !== 0 || (declList.flags & ts.NodeFlags.Const) !== 0) {
          addError(node.name, "'let' is disallowed as a lexically bound name");
        }
      }
    }

    // ── for loop head lexical var conflict ─────────────────────────
    // ES spec: for (let x; ...) { var x; } — var x conflicts with let x
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const init = ts.isForStatement(node) ? node.initializer : node.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
        if (isLexical) {
          const lexNames = new Set<string>();
          for (const decl of init.declarations) {
            collectBindingNames(decl.name, lexNames);
          }
          if (lexNames.size > 0) {
            const body = ts.isForStatement(node) ? node.statement :
                         ts.isForInStatement(node) ? node.statement : node.statement;
            if (ts.isBlock(body)) {
              collectVarDeclaredNamesInBlock(body, lexNames);
            }
          }
        }
      }
    }

    // ── eval/arguments as binding names in strict mode ────────────────
    // ES spec: It is a SyntaxError to use eval or arguments as a binding
    // identifier in strict mode code (variable declarations, function names, etc.)
    if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "arguments") && isStrictMode(node)) {
      const parent = node.parent;
      // Check if used as a binding name (variable, parameter, function name, catch binding)
      const isBinding = parent && (
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isFunctionExpression(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isClassExpression(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        (ts.isCatchClause(parent) && parent.variableDeclaration &&
         ts.isIdentifier(parent.variableDeclaration.name) &&
         parent.variableDeclaration.name === node)
      );
      if (isBinding) {
        addError(node, `Binding '${node.text}' in strict mode is not allowed`);
      }
    }

    // ── Switch case duplicate lexical declarations ────────────────────
    // ES spec: It is a Syntax Error if the LexicallyDeclaredNames of CaseBlock
    // contains any duplicate entries.
    if (ts.isCaseBlock(node)) {
      checkSwitchCaseLexicalDuplicates(node);
    }

    // ── Class body: static prototype method/field ─────────────────────
    // ES spec: It is a SyntaxError if the PropName of a static method or
    // field is "prototype".
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      for (const member of node.members) {
        if (member.name && !ts.isPrivateIdentifier(member.name)) {
          const isStatic = member.modifiers?.some(
            m => m.kind === ts.SyntaxKind.StaticKeyword
          );
          if (isStatic) {
            const memberName = ts.isIdentifier(member.name) ? member.name.text :
                              ts.isStringLiteral(member.name) ? member.name.text : null;
            if (memberName === "prototype") {
              addError(member, "Classes may not have a static property named 'prototype'");
            }
          }
        }
      }
    }

    // ── Duplicate private names in class body ─────────────────────────
    // ES spec: It is a Syntax Error if PrivateBoundNames of ClassBody contains
    // any duplicate entries, unless the name is used once for a getter and once
    // for a setter and in no other entries.
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      checkDuplicatePrivateNames(node);
    }

    // ── Regex literal validation ────────────────────────────────────
    // Validate regex literals using the native RegExp constructor.
    // This catches invalid flags, duplicate flags, invalid Unicode property
    // escapes, invalid modifiers, etc. that TS's semantic checker would
    // catch but we skip with skipSemanticDiagnostics in the worker pool.
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = (node as ts.RegularExpressionLiteral).text;
      const lastSlash = text.lastIndexOf("/");
      if (lastSlash > 0) {
        const pattern = text.slice(1, lastSlash);
        const flags = text.slice(lastSlash + 1);
        try {
          new RegExp(pattern, flags);
        } catch {
          addError(node, `Invalid regular expression: ${text}`);
        }
      }
    }

    // ── Class method named "constructor" restrictions ─────────────────
    // ES spec: It is a SyntaxError if PropName of a MethodDefinition is "constructor" and
    // the method is a generator, async, getter, or setter.
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      for (const member of node.members) {
        const memberName = getMemberName(member);
        if (memberName === "constructor") {
          const isStaticMember = (member as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.StaticKeyword);
          if (isStaticMember) continue; // static "constructor" is fine
          if (ts.isMethodDeclaration(member) && member.asteriskToken) {
            addError(member, "Class constructor may not be a generator");
          }
          if (ts.isMethodDeclaration(member) && member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            addError(member, "Class constructor may not be an async method");
          }
          if (ts.isGetAccessorDeclaration(member)) {
            addError(member, "Class constructor may not be a getter");
          }
          if (ts.isSetAccessorDeclaration(member)) {
            addError(member, "Class constructor may not be a setter");
          }
        }
      }
    }

    // ── Direct super() call outside constructor ──────────────────────
    // ES spec: super() is only valid inside a class constructor.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      if (!isInsideClassConstructor(node)) {
        addError(node, "super() is only valid inside a class constructor");
      }
    }

    // ── Direct super property outside method ──────────────────────────
    // super.x and super[x] are only valid in methods (including constructors)
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      if (!isInsideMethod(node)) {
        addError(node, "'super' keyword unexpected here");
      }
    }

    // ── Duplicate __proto__ in object literal ────────────────────────
    if (ts.isObjectLiteralExpression(node)) {
      let protoCount = 0;
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const propName = ts.isIdentifier(prop.name) ? prop.name.text :
                          ts.isStringLiteral(prop.name) ? prop.name.text : null;
          if (propName === "__proto__") {
            protoCount++;
            if (protoCount > 1) {
              addError(prop, "Duplicate __proto__ fields are not allowed in object literals");
              break;
            }
          }
        }
      }
    }

    // ── Getter with parameters ─────────────────────────────────────
    // ES spec: A getter must have exactly zero parameters.
    if (ts.isGetAccessorDeclaration(node) && node.parameters.length > 0) {
      addError(node, "Getter must not have any formal parameters");
    }

    // ── Setter with wrong param count ──────────────────────────────
    // ES spec: A setter must have exactly one parameter.
    if (ts.isSetAccessorDeclaration(node) && node.parameters.length !== 1) {
      addError(node, "Setter must have exactly one formal parameter");
    }

    // ── Setter param with destructuring + "use strict" body ────────
    // ES spec: setter parameter is eval/arguments in strict mode
    if (ts.isSetAccessorDeclaration(node) && node.parameters.length === 1) {
      const param = node.parameters[0]!;
      // Check for setter with "use strict" body — this triggers strict mode
      // checks on the parameter (eval/arguments as binding names)
      if (ts.isIdentifier(param.name) && (param.name.text === "eval" || param.name.text === "arguments")) {
        // Check if the body has "use strict"
        if (node.body) {
          for (const stmt of node.body.statements) {
            if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression) &&
                stmt.expression.text === "use strict") {
              addError(param.name, `Binding '${param.name.text}' in strict mode is not allowed`);
              break;
            } else {
              break;
            }
          }
        }
      }
    }

    // ── Cover initialized name in object literal ───────────────────
    // ES spec: PropertyDefinition : CoverInitializedName always throws SyntaxError.
    // ({ x = 1 }) is a CoverInitializedName — only valid in destructuring context.
    // ShorthandPropertyAssignment with an objectAssignmentInitializer is the TS
    // representation of CoverInitializedName.
    if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer) {
      // Check if the parent object literal is NOT in an assignment pattern position
      const objLit = node.parent;
      if (ts.isObjectLiteralExpression(objLit)) {
        if (!isAssignmentPatternContext(objLit)) {
          addError(node, "Invalid shorthand property initializer");
        }
      }
    }

    // ── 'let' as shorthand property in strict mode ─────────────────
    // ES spec: 'let' is not a reserved word but cannot be used as a binding
    // identifier in strict mode, and shorthand property acts as IdentifierReference.
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "let" && isStrictMode(node)) {
      addError(node, "'let' is not allowed as a shorthand property in strict mode");
    }

    // ── Catch clause parameter early errors ─────────────────────────
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const catchParam = node.variableDeclaration;
      // Check for duplicate names in catch parameter destructuring
      const catchNames = new Set<string>();
      const dupeNames = new Set<string>();
      collectBindingNamesWithDuplicateCheck(catchParam.name, catchNames, dupeNames);
      for (const name of dupeNames) {
        addError(catchParam, `Duplicate binding '${name}' in catch parameter`);
      }
      // Check catch body for lexical/function declarations that shadow the catch parameter
      if (node.block && catchNames.size > 0) {
        for (const stmt of node.block.statements) {
          if (ts.isVariableStatement(stmt)) {
            const flags = stmt.declarationList.flags;
            if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
              for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && catchNames.has(decl.name.text)) {
                  addError(decl.name, `Cannot redeclare catch variable '${decl.name.text}' with lexical declaration`);
                }
              }
            }
          }
          // Function declaration with same name as catch parameter
          if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            if (catchNames.has(stmt.name.text)) {
              addError(stmt.name, `Cannot redeclare catch variable '${stmt.name.text}' with function declaration`);
            }
          }
          if (ts.isClassDeclaration(stmt) && stmt.name) {
            if (catchNames.has(stmt.name.text)) {
              addError(stmt.name, `Cannot redeclare catch variable '${stmt.name.text}' with class declaration`);
            }
          }
        }
      }
    }

    // ── Duplicate lexical declarations in same block ─────────────────
    // Covers class+class, let+let, const+const, class+let, etc.
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      checkDuplicateLexicalDeclarations(node);
    }

    // ── break/continue outside valid context ──────────────────────────
    // TS catches these as semantic errors (1104, 1105) but we skip semantic
    // diagnostics in the test262 worker, so detect them here.
    if (ts.isContinueStatement(node)) {
      if (!isInsideIteration(node, node.label?.text)) {
        addError(node, node.label
          ? `A 'continue' statement can only jump to a label of an enclosing iteration statement`
          : `A 'continue' statement can only be used within an enclosing iteration statement`);
      }
    }
    if (ts.isBreakStatement(node)) {
      if (!isInsideBreakable(node, node.label?.text)) {
        addError(node, node.label
          ? `A 'break' statement can only jump to a label of an enclosing statement`
          : `A 'break' statement can only be used within an enclosing iteration or switch statement`);
      }
    }

    ts.forEachChild(node, visit);
  }

  /** Get the computed name of a class member, if it's a simple string. */
  function getMemberName(member: ts.ClassElement): string | null {
    if (!member.name) return null;
    if (ts.isIdentifier(member.name)) return member.name.text;
    if (ts.isStringLiteral(member.name)) return member.name.text;
    if (ts.isComputedPropertyName(member.name)) {
      const expr = member.name.expression;
      if (ts.isStringLiteral(expr)) return expr.text;
    }
    return null;
  }

  /** Check if a node is inside a class constructor. Arrow functions inherit super() context. */
  function isInsideClassConstructor(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isConstructorDeclaration(current)) return true;
      // Arrow functions inherit super context — don't stop
      if (ts.isArrowFunction(current)) {
        current = current.parent;
        continue;
      }
      // Other function boundaries break super() context
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is inside a method (class or object). Arrow functions inherit super property context. */
  function isInsideMethod(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) ||
          ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
        return true;
      }
      // Arrow functions inherit super property context — don't stop
      if (ts.isArrowFunction(current)) {
        current = current.parent;
        continue;
      }
      // Other function boundaries break super property context
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is an iteration statement. */
  function isIterationStatement(node: ts.Node): boolean {
    return ts.isForStatement(node) || ts.isForInStatement(node) ||
           ts.isForOfStatement(node) || ts.isWhileStatement(node) ||
           ts.isDoStatement(node);
  }

  /** Check if `continue` is inside a valid iteration statement. Respects labels and function boundaries. */
  function isInsideIteration(node: ts.Node, label?: string): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      // Function boundaries stop the search
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current) || ts.isMethodDeclaration(current) ||
          ts.isConstructorDeclaration(current) || ts.isGetAccessorDeclaration(current) ||
          ts.isSetAccessorDeclaration(current)) {
        return false;
      }
      if (label) {
        // continue LABEL: the label must be on an iteration statement
        if (ts.isLabeledStatement(current) && current.label.text === label) {
          return isIterationStatement(current.statement);
        }
      } else {
        // continue (no label): any enclosing iteration statement
        if (isIterationStatement(current)) return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if `break` is inside a valid breakable statement. Respects labels and function boundaries. */
  function isInsideBreakable(node: ts.Node, label?: string): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      // Function boundaries stop the search
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current) || ts.isMethodDeclaration(current) ||
          ts.isConstructorDeclaration(current) || ts.isGetAccessorDeclaration(current) ||
          ts.isSetAccessorDeclaration(current)) {
        return false;
      }
      if (label) {
        // break LABEL: any labeled statement (not just iteration/switch)
        if (ts.isLabeledStatement(current) && current.label.text === label) {
          return true;
        }
      } else {
        // break (no label): iteration or switch
        if (isIterationStatement(current) || ts.isSwitchStatement(current)) return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check for duplicate lexical declarations (let, const, class, function) in a block. */
  function checkDuplicateLexicalDeclarations(block: ts.Block | ts.SourceFile): void {
    const stmts = block.statements;
    const lexNames = new Map<string, ts.Node>();

    function addLexName(name: string, errorNode: ts.Node) {
      if (lexNames.has(name)) {
        addError(errorNode, `Duplicate identifier '${name}'`);
      } else {
        lexNames.set(name, errorNode);
      }
    }

    for (const stmt of stmts) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        addLexName(stmt.name.text, stmt.name);
      }
      // FunctionDeclaration (including async, generator, async generator) in a block
      // are lexically scoped — duplicates are SyntaxErrors per ES spec.
      // Skip overload signatures (no body) — TypeScript allows multiple signatures.
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        addLexName(stmt.name.text, stmt.name);
      }
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              addLexName(decl.name.text, decl.name);
            }
          }
        }
      }
    }
  }

  /** Check duplicate lexical declarations across switch case clauses. */
  function checkSwitchCaseLexicalDuplicates(caseBlock: ts.CaseBlock): void {
    const lexNames = new Map<string, ts.Node>(); // name -> first declaration
    const varNames = new Map<string, ts.Node>(); // name -> first var declaration
    for (const clause of caseBlock.clauses) {
      for (const stmt of clause.statements) {
        if (ts.isVariableStatement(stmt)) {
          const flags = stmt.declarationList.flags;
          if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                const name = decl.name.text;
                if (lexNames.has(name)) {
                  addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
                } else {
                  lexNames.set(name, decl.name);
                }
                // Check var/lex conflict
                if (varNames.has(name)) {
                  addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
                }
              }
            }
          } else {
            // var declaration
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                const name = decl.name.text;
                if (!varNames.has(name)) varNames.set(name, decl.name);
                // Check lex/var conflict
                if (lexNames.has(name)) {
                  addError(decl.name, `Cannot redeclare block-scoped variable '${name}'`);
                }
              }
            }
          }
        } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
          const name = stmt.name.text;
          if (lexNames.has(name)) {
            addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
          } else {
            lexNames.set(name, stmt.name);
          }
          // Check var/lex conflict
          if (varNames.has(name)) {
            addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
          }
        } else if (ts.isClassDeclaration(stmt) && stmt.name) {
          const name = stmt.name.text;
          if (lexNames.has(name)) {
            addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
          } else {
            lexNames.set(name, stmt.name);
          }
          // Check var/lex conflict
          if (varNames.has(name)) {
            addError(stmt.name, `Cannot redeclare block-scoped variable '${name}'`);
          }
        }
      }
    }
  }

  /** Check for duplicate private names in a class body. */
  function checkDuplicatePrivateNames(classNode: ts.ClassDeclaration | ts.ClassExpression): void {
    const privateNames = new Map<string, { kinds: Set<string> }>();
    for (const member of classNode.members) {
      if (member.name && ts.isPrivateIdentifier(member.name)) {
        const name = member.name.text;
        let kind: string;
        if (ts.isGetAccessorDeclaration(member)) {
          kind = "get";
        } else if (ts.isSetAccessorDeclaration(member)) {
          kind = "set";
        } else if (ts.isMethodDeclaration(member)) {
          kind = "method";
        } else if (ts.isPropertyDeclaration(member)) {
          kind = "field";
        } else {
          kind = "other";
        }

        const existing = privateNames.get(name);
        if (!existing) {
          privateNames.set(name, { kinds: new Set([kind]) });
        } else {
          // get+set pair is allowed; anything else is a duplicate
          const combined = new Set([...existing.kinds, kind]);
          if (combined.size === 2 && combined.has("get") && combined.has("set")) {
            // This is fine — getter+setter pair
            existing.kinds.add(kind);
          } else {
            addError(member.name, `Duplicate private name '${name}'`);
          }
        }
      }
    }
  }

  /** Check if a node is inside an async function (including async generators). */
  function isInsideAsyncFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)) {
        return current.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      }
      if (ts.isArrowFunction(current)) {
        return current.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is inside a generator function (including async generators). */
  function isInsideGeneratorFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) &&
          current.asteriskToken) {
        return true;
      }
      if (ts.isMethodDeclaration(current) && current.asteriskToken) {
        return true;
      }
      // Arrow functions are never generators, but they don't create a new yield scope
      // If we hit an arrow, keep going up — arrows inherit the generator context
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)) {
        return false; // Found a non-generator function boundary
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a function declaration is in a single-statement position (not a block). */
  function isStatementPosition(parent: ts.Node, child: ts.Node): boolean {
    // If the parent is a block/source file, this is a normal declaration — allowed
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) return false;
    // If/else, while, do-while, for, for-in, for-of bodies that are not blocks
    if (ts.isIfStatement(parent)) {
      return parent.thenStatement === child || parent.elseStatement === child;
    }
    if (ts.isWhileStatement(parent)) return parent.statement === child;
    if (ts.isDoStatement(parent)) return parent.statement === child;
    if (ts.isForStatement(parent)) return parent.statement === child;
    if (ts.isForInStatement(parent)) return parent.statement === child;
    if (ts.isForOfStatement(parent)) return parent.statement === child;
    if (ts.isLabeledStatement(parent)) return parent.statement === child;
    if (ts.isWithStatement(parent)) return parent.statement === child;
    return false;
  }

  /** Check if a node has the 'async' modifier. */
  function hasAsyncModifier(node: ts.FunctionDeclaration): boolean {
    return node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  }

  /** Check if a private identifier is inside a class that declares it. */
  function isInsideClassWithPrivateName(node: ts.Node, privateName: string): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
        // Check if this class declares the private name
        for (const member of current.members) {
          if (member.name && ts.isPrivateIdentifier(member.name)) {
            if ((member.name.escapedText as string) === privateName) {
              return true;
            }
          }
        }
        // Also check parent classes (super), but we can't easily resolve inheritance
        // at the AST level. For now, just check the immediate class.
        // Continue searching outer classes.
      }
      current = current.parent;
    }
    return false;
  }

  /** Check for var/lexical declaration conflicts in a block. */
  function checkVarLexicalConflicts(block: ts.Block): void {
    // Collect lexically-declared names (let, const, function, class)
    const lexicalNames = new Set<string>();
    for (const stmt of block.statements) {
      if (ts.isVariableStatement(stmt)) {
        const flags = stmt.declarationList.flags;
        if ((flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              lexicalNames.add(decl.name.text);
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        lexicalNames.add(stmt.name.text);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        lexicalNames.add(stmt.name.text);
      }
    }

    if (lexicalNames.size === 0) return;

    // Check var declarations against lexical names — including vars in nested blocks
    // (var hoists to the enclosing function/module scope, so `{ let x; { var x; } }` is a conflict)
    collectVarDeclaredNamesInBlock(block, lexicalNames);
  }

  /** Recursively collect var-declared names in a block and report conflicts with lexicalNames. */
  function collectVarDeclaredNamesInBlock(node: ts.Node, lexicalNames: Set<string>): void {
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      if ((flags & ts.NodeFlags.Let) === 0 && (flags & ts.NodeFlags.Const) === 0) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && lexicalNames.has(decl.name.text)) {
            addError(decl.name, `Cannot redeclare block-scoped variable '${decl.name.text}'`);
          }
        }
      }
      return;
    }
    // Don't cross function boundaries (var doesn't hoist past functions)
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) {
      return;
    }
    ts.forEachChild(node, child => collectVarDeclaredNamesInBlock(child, lexicalNames));
  }

  /**
   * Check for temporal dead zone (TDZ) violations in a list of statements.
   * A TDZ violation occurs when a let/const variable is referenced before
   * its declaration in the same scope.
   *
   * Handles two patterns:
   * 1. Use in a prior statement: `x; let x;`
   * 2. Use in the initializer of the declaration itself: `let x = x + 1;`
   */
  function checkTDZInStatements(stmts: ts.NodeArray<ts.Statement>) {
    // Collect all let/const declarations with their positions
    const letConstDecls = new Map<string, ts.Node>(); // name -> declaration node
    for (const stmt of stmts) {
      if (ts.isVariableStatement(stmt)) {
        const declList = stmt.declarationList;
        const flags = declList.flags;
        const isLetOrConst = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0;
        if (isLetOrConst) {
          for (const decl of declList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              letConstDecls.set(decl.name.text, decl);
            }
          }
        }
      }
    }

    if (letConstDecls.size === 0) return;

    // For each statement, check if it uses a let/const variable that is declared later
    // We need to track which variables have been declared so far
    const declaredSoFar = new Set<string>();

    for (const stmt of stmts) {
      // Before processing this statement's declarations, check for references
      // to not-yet-declared let/const variables
      if (ts.isVariableStatement(stmt)) {
        const declList = stmt.declarationList;
        const flags = declList.flags;
        const isLetOrConst = (flags & ts.NodeFlags.Let) !== 0 || (flags & ts.NodeFlags.Const) !== 0;
        if (isLetOrConst) {
          for (const decl of declList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer) {
              // Check the initializer for self-references (e.g., `let x = x + 1`)
              const varName = decl.name.text;
              if (letConstDecls.has(varName) && !declaredSoFar.has(varName)) {
                checkForTDZRef(decl.initializer, varName);
              }
            }
            // Now mark this declaration as available
            if (ts.isIdentifier(decl.name)) {
              declaredSoFar.add(decl.name.text);
            }
          }
          continue;
        }
      }

      // For non-declaration statements, check if they reference any
      // let/const variable not yet declared
      for (const [name] of letConstDecls) {
        if (!declaredSoFar.has(name)) {
          checkForTDZRef(stmt, name);
        }
      }
    }
  }

  /**
   * Check if a node tree references an identifier by name.
   * Used to detect TDZ violations.
   */
  function checkForTDZRef(node: ts.Node, name: string) {
    if (ts.isIdentifier(node) && node.text === name) {
      // Make sure this isn't a property name or type reference
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return; // It's a property name like obj.x, not a variable reference
      }
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
        return; // It's a property name in an object literal
      }
      // Emit as warning — test262 expects runtime ReferenceError, not compile error
      const p = pos(node);
      errors.push({ message: `Cannot access '${name}' before initialization`, line: p.line, column: p.column, severity: "warning" });
      return;
    }
    // Don't descend into nested function scopes -- they create their own TDZ
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return;
    }
    ts.forEachChild(node, (child: ts.Node) => checkForTDZRef(child, name));
  }

  /**
   * Check if an object literal is in a destructuring assignment context.
   * In that context, CoverInitializedName ({ x = 1 }) is valid.
   */
  function isAssignmentPatternContext(objLit: ts.ObjectLiteralExpression): boolean {
    const parent = objLit.parent;
    if (!parent) return false;
    // Direct destructuring: ({ x = 1 } = source)
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === objLit) {
      return true;
    }
    // In for-of/for-in LHS
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.initializer === objLit;
    }
    // Nested in another destructuring pattern (array element, object property value)
    if (ts.isArrayLiteralExpression(parent)) return isAssignmentPatternContext_expr(parent);
    if (ts.isPropertyAssignment(parent)) {
      const grandParent = parent.parent;
      if (ts.isObjectLiteralExpression(grandParent)) return isAssignmentPatternContext(grandParent);
    }
    if (ts.isSpreadElement(parent)) {
      const grandParent = parent.parent;
      if (ts.isArrayLiteralExpression(grandParent)) return isAssignmentPatternContext_expr(grandParent);
    }
    return false;
  }

  function isAssignmentPatternContext_expr(arrLit: ts.ArrayLiteralExpression): boolean {
    const parent = arrLit.parent;
    if (!parent) return false;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === arrLit) return true;
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === arrLit;
    if (ts.isArrayLiteralExpression(parent)) return isAssignmentPatternContext_expr(parent);
    if (ts.isPropertyAssignment(parent)) {
      const gp = parent.parent;
      if (ts.isObjectLiteralExpression(gp)) return isAssignmentPatternContext(gp);
    }
    return false;
  }

  visit(sourceFile);
  return errors;
}

function classifyImport(name: string, mod: WasmModule): ImportIntent {
  // String literals
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) return { type: "string_literal", value: strValue };

  // Console (log, warn, error)
  // For console.log, keep backward-compatible variant format ("number", "bool", etc.)
  if (name === "console_log_number") return { type: "console_log", variant: "number" };
  if (name === "console_log_bool") return { type: "console_log", variant: "bool" };
  if (name === "console_log_string") return { type: "console_log", variant: "string" };
  if (name === "console_log_externref") return { type: "console_log", variant: "externref" };
  for (const cm of ["warn", "error"]) {
    if (name === `console_${cm}_number`) return { type: "console_log", variant: `${cm}_number` };
    if (name === `console_${cm}_bool`) return { type: "console_log", variant: `${cm}_bool` };
    if (name === `console_${cm}_string`) return { type: "console_log", variant: `${cm}_string` };
    if (name === `console_${cm}_externref`) return { type: "console_log", variant: `${cm}_externref` };
  }

  // Math
  if (name.startsWith("Math_")) return { type: "math", method: name.slice(5) };

  // String compare (lexicographic ordering)
  if (name === "string_compare") return { type: "builtin", name };

  // String methods
  if (name.startsWith("string_")) return { type: "string_method", method: name.slice(7) };

  // Builtins
  if (name === "number_toString") return { type: "builtin", name };
  if (name === "number_toFixed") return { type: "builtin", name };
  if (name === "number_toPrecision") return { type: "builtin", name };
  if (name === "number_toExponential") return { type: "builtin", name };

  // Date
  if (name === "Date_new") return { type: "date_new" };
  if (name.startsWith("Date_")) return { type: "date_method", method: name.slice(5) };

  // Extern classes — check mod.externClasses
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    if (name === `${prefix}_new`) return { type: "extern_class", className: ec.className, action: "new" };
    for (const [methodName] of ec.methods) {
      if (name === `${prefix}_${methodName}`) return { type: "extern_class", className: ec.className, action: "method", member: methodName };
    }
    for (const [propName] of ec.properties) {
      if (name === `${prefix}_get_${propName}`) return { type: "extern_class", className: ec.className, action: "get", member: propName };
      if (name === `${prefix}_set_${propName}`) return { type: "extern_class", className: ec.className, action: "set", member: propName };
    }
  }

  // Callback maker
  if (name === "__make_callback") return { type: "callback_maker" };

  // Async/await
  if (name === "__await") return { type: "await" };

  // Dynamic import()
  if (name === "__dynamic_import") return { type: "dynamic_import" };

  // Proxy
  if (name === "__proxy_create") return { type: "proxy_create" };

  // Union type helpers
  if (name === "__typeof_number") return { type: "typeof_check", targetType: "number" };
  if (name === "__typeof_string") return { type: "typeof_check", targetType: "string" };
  if (name === "__typeof_boolean") return { type: "typeof_check", targetType: "boolean" };
  if (name === "__typeof_undefined") return { type: "typeof_check", targetType: "undefined" };
  if (name === "__typeof_object") return { type: "typeof_check", targetType: "object" };
  if (name === "__typeof_function") return { type: "typeof_check", targetType: "function" };
  if (name === "__unbox_number") return { type: "unbox", targetType: "number" };
  if (name === "__unbox_boolean") return { type: "unbox", targetType: "boolean" };
  if (name === "__box_number") return { type: "box", targetType: "number" };
  if (name === "__box_boolean") return { type: "box", targetType: "boolean" };
  if (name === "__is_truthy") return { type: "truthy_check" };
  if (name === "__typeof") return { type: "builtin", name: "__typeof" };

  // globalThis
  if (name === "__get_globalThis") return { type: "declared_global", name: "globalThis" };

  // Extern get/set
  if (name === "__extern_get") return { type: "extern_get" };
  if (name === "__extern_set") return { type: "extern_set" };

  // Declared globals (like `declare const document: Document`)
  if (name.startsWith("global_")) return { type: "declared_global", name: name.slice(7) };

  // Unknown constructor imports (__new_ClassName)
  if (name.startsWith("__new_")) {
    return { type: "extern_class", className: name.slice(6), action: "new" };
  }

  // Fallback
  return { type: "builtin", name };
}

function buildImportManifest(mod: WasmModule): ImportDescriptor[] {
  const manifest: ImportDescriptor[] = [];
  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    manifest.push({
      module: "env",
      name: imp.name,
      kind: imp.desc.kind === "func" ? "func" : "global",
      intent: classifyImport(imp.name, mod),
    });
  }
  return manifest;
}

/** Check if TS syntax errors look like the source is plain JavaScript (no type annotations). */
function looksLikeTsSyntaxOnJs(diagnostics: readonly { code: number; messageText: string | ts.DiagnosticMessageChain }[]): boolean {
  // TS error codes that indicate TS-specific syntax was expected but not found,
  // or the parser hit JS-only patterns it can't handle in .ts mode.
  // Common: 1005 (';' expected), 2304 (cannot find name), 2552 (cannot find name, did you mean),
  // 1109 (expression expected — happens with arrow functions returning JSX-like).
  // We also check message text for typical TS-on-JS confusion.
  for (const d of diagnostics) {
    const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    // These patterns strongly suggest the user passed JS to the TS parser
    if (msg.includes("Type annotations can only be used in TypeScript files")) return true;
    if (msg.includes("types can only be used in a .ts file")) return true;
    if (msg.includes("'type' modifier cannot be used in a JavaScript file")) return true;
  }
  return false;
}

/**
 * Detect untyped parameters in JS mode and add helpful warnings suggesting JSDoc annotations.
 * Returns warning CompileErrors for each function parameter that resolved to 'any'.
 */
function checkJsTypeCoverage(ast: TypedAST): CompileError[] {
  const warnings: CompileError[] = [];
  const sf = ast.sourceFile;

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const fnName = node.name.text;
      for (const param of node.parameters) {
        const paramType = ast.checker.getTypeAtLocation(param);
        if (paramType.flags & ts.TypeFlags.Any) {
          const paramName = ts.isIdentifier(param.name) ? param.name.text : "?";
          const { line, character } = sf.getLineAndCharacterOfPosition(param.getStart());
          warnings.push({
            message: `Parameter '${paramName}' in function '${fnName}' has implicit 'any' type. ` +
              `Add a JSDoc annotation: /** @param {number} ${paramName} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
      // Check return type
      const sig = ast.checker.getSignatureFromDeclaration(node);
      if (sig) {
        const retType = ast.checker.getReturnTypeOfSignature(sig);
        if (retType.flags & ts.TypeFlags.Any) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.name.getStart());
          warnings.push({
            message: `Function '${fnName}' has implicit 'any' return type. ` +
              `Add a JSDoc annotation: /** @returns {number} */`,
            line: line + 1,
            column: character + 1,
            severity: "warning",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return warnings;
}

// TS diagnostics that the wasm codegen can handle gracefully —
// downgrade from error to warning so they don't block compilation.
const DOWNGRADE_DIAG_CODES = new Set([
  2304, // "Cannot find name 'X'" — unknown identifiers compiled as externref/unreachable
  2345, // "Argument of type 'X' is not assignable to parameter of type 'Y'"
  2322, // "Type 'X' is not assignable to type 'Y'"
  2339, // "Property 'X' does not exist on type 'Y'" — dynamic property access
  2551, // "Property 'X' does not exist on type 'Y'. Did you mean 'Z'?" — variant of 2339 with suggestion (#613)
  2454, // "Variable 'X' is used before being assigned"
  2531, // "Object is possibly 'null'" — codegen has null guards (#406)
  2532, // "Object is possibly 'undefined'" — codegen has null guards (#406)
  2533, // "Object is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2367, // "This comparison appears to be unintentional" (always truthy/falsy)
  2554, // "Expected N arguments, but got M"
  2683, // "'this' implicitly has type 'any'"
  2695, // "Left side of comma operator is unused and has no side effects"
  2769, // "No overload matches this call"
  18047, // "'X' is possibly 'null'" — codegen has null guards (#406)
  18049, // "'X' is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2358, // "The left-hand side of an 'instanceof' expression must be..."
  2356, // "An arithmetic operand must be of type 'any', 'number', 'bigint' or an enum type" — prefix/postfix inc/dec on non-number
  2362, // "The left-hand side of an arithmetic operation must be..."
  2365, // "Operator 'X' cannot be applied to types 'Y' and 'Z'"
  1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
  1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
  18050, // "The value 'null'/'undefined' cannot be used here"
  2698, // "Spread types may only be created from object types" — codegen handles spread generically (#536)
  2872, // "This kind of expression is always truthy"
  2873, // "This kind of expression is always falsy"
  2363, // "The right-hand side of an arithmetic operation must be..."
  2869, // "Right operand of ?? is unreachable because the left operand is never nullish"
  2349, // "This expression is not callable"
  2552, // "Cannot find name 'X'. Did you mean 'Y'?"
  18046, // "'X' is of type 'unknown'"
  2881, // "This expression is never nullish" — false positive in allowJs mode
  2871, // "This expression is always nullish"
  18048, // "'X' is possibly 'undefined'"
  2839, // "This condition will always return true/false since JS compares objects by reference"
  2703, // "The operand of a 'delete' operator must be a property reference"
  2704, // "The operand of a 'delete' operator cannot be a read-only property" — valid JS delete (#520)
  2790, // "The operand of a 'delete' operator must be optional" — valid JS delete (#520)
  2630, // "Cannot assign to 'X' because it is a function"
  2447, // "The '|'/'&' operator is not allowed for boolean types"
  2300, // "Duplicate identifier 'X'"
  2408, // "Setters cannot return a value" — valid in JS, codegen handles it
  1345, // "An expression of type 'void' cannot be tested for truthiness"
  2350, // "Only a void function can be called with the 'new' keyword"
  2403, // "Subsequent variable declarations must have the same type" — var re-declarations legal in JS
  2377, // "Constructors for derived classes must contain a 'super' call" — valid JS pattern
  2376, // "A 'super' call must be the first statement in the constructor" — valid JS pattern
  17009, // "'super' must be called before accessing 'this' in derived class constructor"
  17011, // "'super' must be called before accessing a property of 'super' in derived class constructor"
  2540, // "Cannot assign to 'X' because it is a read-only property" — private fields are writable in JS
  2803, // "Cannot assign to private method 'X'. Private methods are not writable" — valid JS pattern
  2806, // "Private accessor was defined without a getter" — valid JS pattern
  18030, // "An optional chain cannot contain private identifiers" — valid JS pattern
  2729, // "Property 'X' is used before its initialization" — valid JS pattern
  1163, // "A 'yield' expression is only allowed in a generator body" — #267
  1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
  1220, // "Generators are not allowed in an ambient context" — valid JS pattern (#267)
  1166, // "A computed property name in a class property declaration must have a simple literal type" — #265
  2464, // "A computed property name must be of type 'string', 'number', 'symbol', or 'any'" — #276
  2488, // "Type must have a '[Symbol.iterator]()' method" — #268
  2489, // "An iterator must have a 'next()' method" — iterator protocol (#153)
  1103, // "'for await' loops are only allowed within async functions and at the top levels of modules" — #612
  2504, // "Type must have a '[Symbol.asyncIterator]()' method that returns an async iterator" — #612
  2519, // "An async iterator must have a 'next()' method" — async iterator protocol (#612)
  2547, // "The type returned by the 'next()' method of an async iterator must be a promise for a type with a 'value' property" — #612
  2548, // "Type is not an array type or does not have '[Symbol.iterator]()'" — #268
  2549, // "Type is not an array/string type or does not have '[Symbol.iterator]()'" — #268
  2768, // "The 'next' property of an async iterator must be a method" — #612
  2763, // "Cannot iterate value because the 'next' method expects type X" — for-of iteration (#153)
  2764, // "Cannot iterate value because the 'next' method expects type X (array spread)" — (#153)
  2765, // "Cannot iterate value because the 'next' method expects type X (destructuring)" — (#153)
  18014, // "The property '#x' cannot be accessed on type 'X' within this class because it is shadowed" — valid JS
  2538, // "Type 'X' cannot be used as an index type" — valid JS pattern (e.g. symbol/boolean as index)
  1468, // "A computed property name must be of type 'string', 'number', 'symbol', or 'any'" — valid JS
  2556, // "A spread argument must either have a tuple type or be passed to a rest parameter" — valid JS spread (#382)
  2741, // "Property 'X' is missing in type 'Y' but required in type 'Z'" — valid JS object patterns
  2493, // "Tuple type '[]' of length 'N' has no element at index 'M'" — destructuring empty/short tuples (#379)
  2689, // "Cannot extend an interface 'X'. Did you mean 'implements'?" — Iterator/Generator class patterns (#616)
  2700, // "Rest types may only be created from object types" — object rest on primitives (#379)
  1212, // "Identifier expected. 'X' is a reserved word in strict mode" — valid in sloppy JS (#270)
  1214, // "Identifier expected. 'yield' is a reserved word in strict mode. Modules are automatically in strict mode." — yield as identifier in sloppy JS (#241)
  1308, // "'await' expressions are only allowed within async functions and at the top levels of modules" — codegen handles await in non-async as identity (#666)
  2378, // "A 'get' accessor must return a value" — valid JS pattern, getter can return undefined implicitly (#377)
  1052, // "A 'set' accessor parameter cannot have an initializer" — valid JS pattern, setter params can have defaults (#377)
  7033, // "Property 'X' implicitly has type 'any', because its get accessor lacks a return type annotation" — valid JS (#377)
  1100, // "Invalid use of 'X' in strict mode" — sloppy-mode JS allows assignment to eval/arguments (#331)
  1215, // "Invalid use of 'X'. Modules are automatically in strict mode" — sloppy-mode JS allows eval/arguments as targets (#331)
  1210, // "Code contained in a class is evaluated in strict mode which does not allow this use of 'X'" — sloppy-mode JS pattern (#331)
  1156, // "'let' declarations can only be declared inside a block" — sloppy-mode JS pattern (#383)
  1313, // "The body of an 'if' statement cannot be the empty statement" — sloppy-mode JS pattern (#383)
  1344, // "A label is not allowed here" — labeled function declarations in sloppy-mode JS (#383)
  1182, // "A destructuring declaration must have an initializer" — valid JS pattern (#383)
  1228, // "A type predicate is only allowed in return type position" — valid JS pattern (#383)
  7053, // "Element implicitly has an 'any' type because expression can't be used to index type" — numeric/string index on plain objects (#391)
  2318, // "Cannot find global type 'X'" — e.g. ClassDecoratorContext, AsyncIterableIterator (#271)
  2468, // "Cannot find global value 'X'" — e.g. Promise (#271)
  2583, // "Cannot find name 'X'. Do you need to change your target library?" — e.g. BigInt, Reflect (#271)
  2585, // "'X' only refers to a type, but is being used as a value here" (target library) (#271)
  2693, // "'X' only refers to a type, but is being used as a value here" (#271)
  2697, // "An async function or method must return a 'Promise'" (#271)
  2705, // "An async function or method in ES5 requires the 'Promise' constructor" (#271)
  1206, // "Decorators are not valid here" — decorator syntax suppressed, decorators ignored (#376)
  1207, // "Decorators cannot be applied to multiple get/set accessors of the same name" (#376)
  1236, // "The return type of a property decorator function must be either 'void' or 'any'" (#376)
  1237, // "The return type of a parameter decorator function must be either 'void' or 'any'" (#376)
  1238, // "Unable to resolve signature of class decorator when called as an expression" (#271)
  1239, // "Unable to resolve signature of parameter decorator when called as an expression" (#271)
  1240, // "Unable to resolve signature of property decorator when called as an expression" (#271)
  1241, // "Unable to resolve signature of method decorator when called as an expression" (#271)
  1249, // "A decorator can only decorate a method implementation, not an overload" (#376)
  1270, // "Decorator function return type is not assignable" (#376)
  1271, // "Decorator function return type is not void or any" (#376)
  1278, // "The runtime will invoke the decorator with N arguments, but the decorator expects M" (#376)
  1279, // "The runtime will invoke the decorator with N arguments, but the decorator expects at least M" (#376)
  1329, // "Decorator accepts too few arguments" (#376)
  1433, // "Neither decorators nor modifiers may be applied to 'this' parameters" (#376)
  1436, // "Decorators must precede the name and all keywords of property declarations" (#376)
  1486, // "Decorator used before 'export' here" (#376)
  1497, // "Expression must be enclosed in parentheses to be used as a decorator" (#376)
  1498, // "Invalid syntax in decorator" (#376)
  8038, // "Decorators may not appear after 'export' or 'export default'" (#376)
  18036, // "Class decorators can't be used with static private identifier" (#376)
  2372, // "Parameter 'x' cannot reference itself" — valid JS pattern (#413)
  2373, // "Parameter 'x' cannot reference identifier 'y' declared after it" — valid JS pattern (#413)
  2735, // "Initializer of parameter 'x' cannot reference identifier 'y'" — valid JS pattern (#413)
  1106, // "The left-hand side of a 'for...of' statement may not be 'async'" — valid in sloppy-mode JS (#425)
  2711, // "A dynamic import call returns a 'Promise'" — dynamic import() (#440)
  2792, // "Cannot find module 'X'" — dynamic import() module resolution (#440)
  2739, // "Type 'X' is missing properties: next, return, throw" — generator type mismatch (#439)
  2802, // "Type 'X' can only be iterated through when using '--downlevelIteration'" — generators in for-of (#439)
  1102, // "'delete' cannot be called on an identifier in strict mode" — valid sloppy-mode JS (#535)
  1184, // "Modifiers cannot appear here" — valid JS patterns in test262 (#537)
  1109, // "Expression expected" — valid JS patterns in test262 (#537)
  1135, // "Argument expression expected" — valid JS patterns in test262 (#537)
  2351, // "This expression is not constructable" — valid JS patterns in test262 (#537)
  2335, // "'super' can only be referenced in a derived class" — valid JS patterns in test262 (#537)
  2660, // "'super' can only be referenced in members of derived classes or object literal expressions" — valid JS (#537)
  2508, // "No base constructor has the specified number of type arguments" — valid JS patterns in test262 (#537)
  1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" — await as identifier (#537)
  2393, // "Duplicate function implementation" — valid JS function re-declarations (#537)
  2721, // "Cannot invoke an object which is possibly 'null' or 'undefined'" — codegen has null guards (#406)
  2722, // "Cannot invoke an object which is possibly 'null'" — codegen has null guards (#406)
  2723, // "Cannot invoke an object which is possibly 'undefined'" — codegen has null guards (#406)
  2448, // "Block-scoped variable 'X' used before its declaration" — valid JS TDZ pattern, runtime ReferenceError (#723)
  2474, // "Cannot access 'X' before initialization" — valid JS TDZ pattern, runtime ReferenceError (#723)
  1489, // "Decimals with leading zeros are not allowed" — valid sloppy-mode JS octal literals
  1121, // "Octal literals are not allowed in strict mode" — valid sloppy-mode JS
]);

/**
 * Orchestrates the full compilation pipeline:
 * TS Source → tsc Parser+Checker → Codegen → Binary + WAT
 */
export function compileSource(
  source: string,
  options: CompileOptions = {},
  /** Optional persistent language service for incremental compilation */
  languageService?: IncrementalLanguageService,
): CompileResult {
  // Reset compile-expression recursion depth counter for this compilation unit.
  // Without this, the depth accumulates across compilations in the same process
  // (e.g., test262 worker pool), causing false "depth exceeded" errors.
  resetCompileDepth();

  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Step 0: Pre-process imports (replace import * as X with declare namespace)
  const processedSource = preprocessImports(source);

  // Step 1: Parse and type-check
  let isJsMode = options.allowJs === true || (options.fileName?.endsWith(".js") ?? false);
  const defaultFileName = options.fileName ?? (isJsMode ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  let ast: TypedAST;
  if (languageService) {
    // Incremental path: reuse cached lib files via the language service
    languageService.updateSource(processedSource, effectiveFileName);
    ast = languageService.analyze({ allowJs: options.allowJs, skipSemanticDiagnostics: options.skipSemanticDiagnostics });
  } else {
    ast = analyzeSource(processedSource, effectiveFileName, { allowJs: options.allowJs, skipSemanticDiagnostics: options.skipSemanticDiagnostics });
  }

  // Auto-detect: if parsing as TS fails with syntax errors that look like
  // the source is plain JS, retry with allowJs mode enabled.
  if (!isJsMode) {
    const syntaxErrors = ast.syntacticDiagnostics.filter(
      (d) => d.category === 1 && d.file === ast.sourceFile,
    );
    if (syntaxErrors.length > 0 && looksLikeTsSyntaxOnJs(syntaxErrors)) {
      // Retry as JS
      isJsMode = true;
      const jsFileName = effectiveFileName.replace(/\.ts$/, ".js");
      if (languageService) {
        languageService.updateSource(processedSource, jsFileName);
        ast = languageService.analyze({ allowJs: true });
      } else {
        ast = analyzeSource(processedSource, jsFileName, { allowJs: true });
      }
    }
  }

  // In JS mode, check for untyped parameters and add helpful warnings
  if (isJsMode) {
    const typeWarnings = checkJsTypeCoverage(ast);
    errors.push(...typeWarnings);
  }

  // TS diagnostics that the wasm codegen can handle gracefully —
  // downgrade from error to warning so they don't block compilation.
  // (Uses module-level DOWNGRADE_DIAG_CODES set defined above)

  // Collect TS diagnostics as errors (or warnings for handled cases)
  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      // Error
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      const severity = DOWNGRADE_DIAG_CODES.has(diag.code) ? "warning" : "error";
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
        code: diag.code,
      });
    }
  }

  // Don't stop on type errors – the compiler can still generate code for many cases
  // Only stop on syntax errors (parsing failures), except tolerated ones
  const TOLERATED_SYNTAX_CODES = new Set([
    1156, // "'let' declarations can only be declared inside a block"
    1313, // "The body of an 'if' statement cannot be the empty statement"
    1344, // "A label is not allowed here"
    1182, // "A destructuring declaration must have an initializer"
    1228, // "A type predicate is only allowed in return type position"
    1163, // "A 'yield' expression is only allowed in a generator body" — syntactic diagnostic (#267)
    1206, // "Decorators are not valid here" — decorator syntax tolerated, decorators ignored (#376)
    1207, // "Decorators cannot be applied to multiple get/set accessors" (#376)
    1436, // "Decorators must precede the name and all keywords of property declarations" (#376)
    1486, // "Decorator used before 'export' here" (#376)
    1497, // "Expression must be enclosed in parentheses to be used as a decorator" (#376)
    1498, // "Invalid syntax in decorator" (#376)
    8038, // "Decorators may not appear after 'export' or 'export default'" (#376)
    1184, // "Modifiers cannot appear here" — valid JS patterns in test262 (#537)
    1109, // "Expression expected" — valid JS patterns in test262 (#537)
    1135, // "Argument expression expected" — valid JS patterns in test262 (#537)
    1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" — await as identifier (#537)
    1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
    1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
    1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
    1102, // "'delete' cannot be called on an identifier in strict mode" — valid sloppy-mode JS (#535)
    1100, // "Invalid use of 'X' in strict mode" — sloppy-mode JS allows eval/arguments (#331)
    1121, // "Octal literals are not allowed in strict mode" — valid sloppy-mode JS
    1489, // "Decimals with leading zeros are not allowed" — valid sloppy-mode JS octal literals
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 1a: Early error detection — catch ES-spec syntax errors that TypeScript misses
  const earlyErrors = detectEarlyErrors(ast.sourceFile);
  errors.push(...earlyErrors);
  const hasHardEarlyErrors = earlyErrors.some(e => e.severity !== "warning");
  if (hasHardEarlyErrors) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 1b: Safe mode validation
  if (options.safe) {
    const safeErrors = validateSafeMode(ast.sourceFile, ast.checker, options);
    errors.push(...safeErrors);
    if (safeErrors.length > 0) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
      };
    }
  }

  // Step 1c: Hardened mode validation
  if (options.hardened) {
    const hardenedErrors = validateHardenedMode(ast.sourceFile);
    errors.push(...hardenedErrors);
    if (hardenedErrors.length > 0) {
      return {
        binary: new Uint8Array(0), wat: "", dts: "", importsHelper: "",
        success: false, errors, stringPool: [], imports: [],
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  // Step 2: Generate IR
  let mod;
  try {
    if (useLinear) {
      mod = generateLinearModule(ast);
    } else {
      const result = generateModule(ast, { sourceMap: emitSourceMap, fast: options.fast, nativeStrings: options.nativeStrings, wasi: options.target === "wasi" });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 2b: Apply C ABI transformations if requested
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module");
    cHeader = cabiResult.cHeader;
  }

  // Step 2c: Widen non-defaultable ref types to ref_null in locals, params, and results.
  // This avoids "uninitialized non-defaultable local" and struct.get/set type errors.
  widenNonDefaultableTypes(mod);

  // Step 3: Emit binary (with source map collection if enabled)
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Generate source map JSON
      const sourcesContent = new Map<string, string>();
      sourcesContent.set(effectiveFileName, source);
      const sourceMap = generateSourceMap(
        emitResult.sourceMapEntries,
        sourcesContent,
      );
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section to the binary
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      // Concatenate the binary with the sourceMappingURL section
      const combined = new Uint8Array(
        emitResult.binary.length + urlSectionBytes.length,
      );
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      // DEBUG: dump __module_init body before emission
      for (const f of mod.functions) {
        if (f.name === "__module_init") {
          console.error("[DEBUG-EMIT] __module_init body:");
          for (let i = 0; i < f.body.length; i++) {
            console.error("  [" + i + "] " + (f.body[i] as any)?.op);
          }
        }
      }
      binary = emitBinary(mod);
    }
  } catch (e) {
    errors.push({
      message: `Binary emit error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Step 3b: Optimize binary with Binaryen (optional)
  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      errors.push({
        message: optResult.warning,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  // Step 4: Emit WAT (optional)
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      // WAT emit failure is non-fatal
      errors.push({
        message: `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  // Step 5: Generate .d.ts
  const dts = generateDts(ast, mod);

  // Step 6: Generate imports helper
  const importsHelper = generateImportsHelper(mod);

  // Step 7: Generate WIT interface (optional)
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(ast, witOpts);
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    cHeader,
    wit: witOutput,
  };
}

/**
 * Apply C ABI transformation to a compiled WasmModule.
 * Rewrites exported function signatures for C compatibility and generates a C header.
 */
function applyCabiTransform(
  mod: WasmModule,
  moduleName: string,
): { cHeader: string } {
  const numImportFuncs = mod.imports.filter(
    (i) => i.desc.kind === "func",
  ).length;

  // Build CabiExportInfo for each exported function
  const exportInfos: CabiExportInfo[] = [];
  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func") continue;
    if (exp.name === "memory") continue;

    const funcIdx = exp.desc.index;
    const localIdx = funcIdx - numImportFuncs;
    if (localIdx < 0 || localIdx >= mod.functions.length) continue;

    const func = mod.functions[localIdx];
    const typeDef = mod.types[func.typeIdx];
    if (!typeDef || typeDef.kind !== "func") continue;

    // Build ParamDefs from the function type
    // In linear memory mode: f64 = number, i32 = pointer (string/array/object)
    // We infer semantics from the function name and wasm types
    const paramDefs: ParamDef[] = typeDef.params.map((wt, i) => {
      // Without TS type info at this stage, we infer from wasm types:
      // f64 → number, i32 → could be string/array/object/boolean
      // For now, treat all i32 params as direct (caller provides i32)
      const semantic = wt.kind === "f64" ? "number_f64" as const : "number_i32" as const;
      return { name: `p${i}`, wasmType: wt, semantic };
    });

    const cabiParams = mapParamsToCabi(paramDefs);
    const resultSemantic = typeDef.results.length === 0
      ? "void" as const
      : typeDef.results[0].kind === "f64"
        ? "number_f64" as const
        : "number_i32" as const;
    const cabiResult = mapResultToCabi(
      typeDef.results.length > 0 ? typeDef.results[0] : null,
      resultSemantic,
    );

    const cabiName = exp.name; // mangleCabiName is identity for simple names

    exportInfos.push({
      tsName: exp.name,
      cabiName,
      params: cabiParams,
      result: cabiResult,
    });
  }

  // Apply wrappers for functions that need them
  emitCabiWrappers(mod, exportInfos);

  // Generate C header from the final module state
  const headerExports = extractCHeaderExports(mod);
  const cHeader = generateCHeader(moduleName, headerExports);

  return { cHeader };
}

/**
 * Compile multiple TypeScript source files into a single Wasm module.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export function compileMultiSource(
  files: Record<string, string>,
  entryFile: string,
  options: CompileOptions = {},
): CompileResult {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  const multiAst = analyzeMultiSource(files, entryFile);

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
      });
    }
  }

  const hasSyntaxErrors = multiAst.syntacticDiagnostics.some(
    (d) => d.category === 1 && multiAst.sourceFiles.some((sf) => d.file === sf),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some(e => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst);
    } else {
      const result = generateMultiModule(multiAst, { sourceMap: emitSourceMap, fast: options.fast, nativeStrings: options.nativeStrings, wasi: options.target === "wasi" });
      mod = result.module;
      // Propagate codegen errors with source locations
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Widen non-defaultable ref types to ref_null in locals, params, and results
  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Build sources content from input files
      const sourcesContent = new Map<string, string>();
      for (const [name, content] of Object.entries(files)) {
        sourcesContent.set(name, content);
      }
      const sourceMap = generateSourceMap(
        emitResult.sourceMapEntries,
        sourcesContent,
      );
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      const combined = new Uint8Array(
        emitResult.binary.length + urlSectionBytes.length,
      );
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    errors.push({
      message: `Binary emit error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Optimize binary with Binaryen (optional)
  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      errors.push({
        message: optResult.warning,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      errors.push({
        message: `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
  };
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via standard module resolution.
 */
export function compileFilesSource(
  entryPath: string,
  options: CompileOptions = {},
): CompileResult {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  const multiAst = analyzeFiles(entryPath, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
  });

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: "error",
      });
    }
  }

  const hasSyntaxErrors = multiAst.syntacticDiagnostics.some(
    (d) => d.category === 1 && multiAst.sourceFiles.some((sf) => d.file === sf),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some(e => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst);
    } else {
      const result = generateMultiModule(multiAst, { sourceMap: emitSourceMap, fast: options.fast, nativeStrings: options.nativeStrings, wasi: options.target === "wasi" });
      mod = result.module;
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: err.severity ?? "error",
        });
      }
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);
      const sourcesContent = new Map<string, string>();
      for (const sf of multiAst.sourceFiles) {
        sourcesContent.set(sf.fileName, sf.getFullText());
      }
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    errors.push({
      message: `Binary emit error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
    };
  }

  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = optimizeBinary(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      errors.push({
        message: optResult.warning,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      errors.push({
        message: `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
  };
}

// ── .d.ts generation ─────────────────────────────────────────────────

function generateDts(ast: TypedAST, mod: WasmModule): string {
  const lines: string[] = ["// Generated by ts2wasm", ""];

  // Exports interface
  const exportLines: string[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      hasExportModifier(stmt)
    ) {
      const name = stmt.name.text;
      const isAsync = mod.asyncFunctions.has(name);
      const params = stmt.parameters
        .map((p) => {
          const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
          const typeText = mapTypeForDts(p.type, ast.sourceFile);
          const optional = p.questionToken ? "?" : "";
          return `${paramName}${optional}: ${typeText}`;
        })
        .join(", ");
      let returnType = mapTypeForDts(stmt.type, ast.sourceFile);
      // For async functions, preserve the Promise<T> wrapper in the .d.ts output
      if (isAsync && !returnType.startsWith("Promise<")) {
        returnType = `Promise<${returnType}>`;
      }
      exportLines.push(`  ${name}(${params}): ${returnType};`);
    }
  }

  if (exportLines.length > 0) {
    lines.push(
      ...exportLines.map((l) => {
        // Convert "  name(params): ret;" to "export declare function name(params): ret;"
        const m = l.match(/^\s+(\w+)\(([^)]*)\):\s*(.+);$/);
        if (m) return `export declare function ${m[1]}(${m[2]}): ${m[3]};`;
        return l;
      }),
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Imports helper generation ────────────────────────────────────────

function generateImportsHelper(mod: WasmModule): string {
  const lines: string[] = [
    "// Generated by ts2wasm — runtime imports helper",
    "// Usage: const imports = createImports(deps);",
    "//        const { instance } = await WebAssembly.instantiate(wasmBytes, imports,",
    "//          { builtins: ['js-string'], importedStringConstants: 'string_constants' }",
    "//        );",
    "",
  ];

  // Determine what we need
  const hasDeps = mod.externClasses.length > 0;
  const hasStringPool = mod.stringPool.length > 0;
  const hasJsString = mod.imports.some((i) => i.module === "wasm:js-string");
  const hasCallbacks = mod.imports.some((i) => i.name === "__make_callback");

  // Late-binding variable for callback support
  if (hasCallbacks) {
    lines.push("let wasmExports;");
    lines.push(
      "export function setExports(exports) { wasmExports = exports; }",
    );
    lines.push("");
  }

  // Function signature
  lines.push(`export function createImports(${hasDeps ? "deps" : ""}) {`);

  // env object
  lines.push("  const env = {");

  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    if (imp.desc.kind !== "func") continue;

    const line = generateEnvImportLine(imp.name, mod);
    lines.push(`    ${line},`);
  }

  lines.push("  };");

  // String constants (importedStringConstants namespace)
  if (hasStringPool) {
    lines.push("");
    lines.push("  // String constants as WebAssembly.Global values");
    lines.push("  const string_constants = {");
    for (const s of mod.stringPool) {
      lines.push(`    ${JSON.stringify(s)}: new WebAssembly.Global({ value: "externref", mutable: false }, ${JSON.stringify(s)}),`);
    }
    lines.push("  };");
  }

  // wasm:js-string polyfill
  if (hasJsString) {
    lines.push("");
    lines.push(
      "  // Polyfill for engines without native wasm:js-string support",
    );
    lines.push("  const jsString = {");
    lines.push("    concat: (a, b) => a + b,");
    lines.push("    length: (s) => s.length,");
    lines.push("    equals: (a, b) => a === b ? 1 : 0,");
    lines.push("    substring: (s, start, end) => s.substring(start, end),");
    lines.push("    charCodeAt: (s, i) => s.charCodeAt(i),");
    lines.push("  };");
  }

  // Return statement
  lines.push("");
  const parts: string[] = ["env"];
  if (hasStringPool) parts.push("string_constants");
  if (hasJsString) parts.push('"wasm:js-string": jsString');
  lines.push(`  return { ${parts.join(", ")} };`);
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function generateEnvImportLine(name: string, mod: WasmModule): string {
  // String literal thunks
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) {
    return `${name}: () => ${JSON.stringify(strValue)}`;
  }

  // Console stubs (log, warn, error)
  for (const cm of ["log", "warn", "error"]) {
    if (name === `console_${cm}_number`)
      return `console_${cm}_number: (v) => console.${cm}(v)`;
    if (name === `console_${cm}_bool`)
      return `console_${cm}_bool: (v) => console.${cm}(Boolean(v))`;
    if (name === `console_${cm}_string`)
      return `console_${cm}_string: (v) => console.${cm}(v)`;
    if (name === `console_${cm}_externref`)
      return `console_${cm}_externref: (v) => console.${cm}(v)`;
  }

  // Primitive method imports
  if (name === "number_toString") return "number_toString: (v) => String(v)";

  // String compare (lexicographic ordering)
  if (name === "string_compare")
    return "string_compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0)";

  // String method imports
  if (name.startsWith("string_")) {
    const method = name.slice(7);
    return `${name}: (s, ...a) => s.${method}(...a)`;
  }

  // String.fromCharCode
  if (name === "String_fromCharCode")
    return "String_fromCharCode: (code) => String.fromCharCode(code)";

  // ToUint32 helper for Math.clz32/imul
  if (name === "__toUint32")
    return "__toUint32: (x) => x >>> 0";

  // Math host imports
  if (name.startsWith("Math_")) {
    const method = name.slice(5);
    return `${name}: Math.${method}`;
  }

  // Extern class imports
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    const nsAccess =
      ec.namespacePath.length > 0
        ? `deps.${ec.namespacePath.join(".")}`
        : `deps`;

    if (name === `${prefix}_new`) {
      const paramList = ec.constructorParams.map((_, i) => `a${i}`).join(", ");
      return `${name}: (${paramList}) => new ${nsAccess}.${ec.className}(${paramList})`;
    }
    for (const [methodName, sig] of ec.methods) {
      if (name === `${prefix}_${methodName}`) {
        const paramList = sig.params
          .slice(1)
          .map((_, i) => `a${i}`)
          .join(", ");
        return `${name}: (self${paramList ? ", " + paramList : ""}) => self.${methodName}(${paramList})`;
      }
    }
    for (const [propName, propInfo] of ec.properties) {
      if (name === `${prefix}_get_${propName}`) {
        return `${name}: (self) => self.${propName}`;
      }
      if (name === `${prefix}_set_${propName}`) {
        return `${name}: (self, v) => { self.${propName} = v; }`;
      }
    }
  }

  // __make_callback: late-binding wrapper
  if (name === "__make_callback") {
    return `${name}: (id, cap) => (...args) => wasmExports[\`__cb_\${id}\`](cap, ...args)`;
  }

  // Async/await support: __await is identity (host functions are sync from Wasm's perspective)
  if (name === "__await") return `${name}: (v) => v`;

  // Generator support
  if (name === "__gen_create_buffer") return `${name}: () => []`;
  if (name === "__gen_push_f64") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__gen_push_i32") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__gen_push_ref") return `${name}: (buf, v) => { buf.push(v); }`;
  if (name === "__create_generator")
    return `${name}: (buf) => { let i = 0; return { next() { if (i < buf.length) return { value: buf[i++], done: false }; return { value: undefined, done: true }; }, return(v) { i = buf.length; return { value: v, done: true }; }, throw(e) { i = buf.length; throw e; }, [Symbol.iterator]() { return this; } }; }`;
  if (name === "__gen_next") return `${name}: (gen) => gen.next()`;
  if (name === "__gen_result_value") return `${name}: (r) => r.value`;
  if (name === "__gen_result_value_f64") return `${name}: (r) => Number(r.value)`;
  if (name === "__gen_result_done") return `${name}: (r) => r.done ? 1 : 0`;

  // Union type helper imports
  if (name === "__typeof_number")
    return `${name}: (v) => typeof v === "number" ? 1 : 0`;
  if (name === "__typeof_string")
    return `${name}: (v) => typeof v === "string" ? 1 : 0`;
  if (name === "__typeof_boolean")
    return `${name}: (v) => typeof v === "boolean" ? 1 : 0`;
  if (name === "__typeof_undefined")
    return `${name}: (v) => typeof v === "undefined" ? 1 : 0`;
  if (name === "__typeof_object")
    return `${name}: (v) => typeof v === "object" ? 1 : 0`;
  if (name === "__typeof_function")
    return `${name}: (v) => typeof v === "function" ? 1 : 0`;
  if (name === "__unbox_number") return `${name}: (v) => Number(v)`;
  if (name === "__unbox_boolean") return `${name}: (v) => v ? 1 : 0`;
  if (name === "__box_number") return `${name}: (v) => v`;
  if (name === "__box_boolean") return `${name}: (v) => Boolean(v)`;
  if (name === "__box_symbol") return `${name}: (() => { const c = new Map([[1,Symbol.iterator],[2,Symbol.hasInstance],[3,Symbol.toPrimitive],[4,Symbol.toStringTag],[5,Symbol.species],[6,Symbol.isConcatSpreadable],[7,Symbol.match],[8,Symbol.replace],[9,Symbol.search],[10,Symbol.split],[11,Symbol.unscopables],[12,Symbol.asyncIterator]]); return (id) => { let s = c.get(id); if (!s) { s = Symbol("wasm_"+id); c.set(id, s); } return s; }; })()`;
  if (name === "__is_truthy") return `${name}: (v) => v ? 1 : 0`;
  if (name === "__typeof") return `${name}: (v) => typeof v`;

  // Callback bridges for functional array methods
  if (name === "__call_1_f64") return `${name}: (fn, a) => fn(a)`;
  if (name === "__call_2_f64") return `${name}: (fn, a, b) => fn(a, b)`;

  // Fallback: no-op stub
  return `${name}: () => {}`;
}

function mapTypeForDts(
  typeNode: ts.TypeNode | undefined,
  sf: ts.SourceFile,
): string {
  if (!typeNode) return "void";
  const text = typeNode.getText(sf);
  if (
    text === "number" ||
    text === "boolean" ||
    text === "string" ||
    text === "void"
  ) {
    return text;
  }
  // Handle Promise<T> type references
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf);
    if (typeName === "Promise" && typeNode.typeArguments?.length === 1) {
      const innerType = mapTypeForDts(typeNode.typeArguments[0], sf);
      return `Promise<${innerType}>`;
    }
  }
  return "any";
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

// ── Object file compilation ─────────────────────────────────────────

export interface ObjectCompileResult {
  /** Relocatable Wasm object file (.o) */
  object: Uint8Array;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * Uses the same pipeline as compileSource but emits LLVM-style
 * linking metadata instead of a final executable module.
 */
export function compileToObjectSource(
  source: string,
  options: CompileOptions = {},
): ObjectCompileResult {
  const errors: CompileError[] = [];

  const processedSource = preprocessImports(source);
  const defaultFileName = options.fileName ?? (options.allowJs ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  const ast = analyzeSource(processedSource, effectiveFileName, { allowJs: options.allowJs });

  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file
        ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0)
        : { line: 0, character: 0 };
      const severity = DOWNGRADE_DIAG_CODES.has(diag.code) ? "warning" : "error";
      errors.push({
        message:
          typeof diag.messageText === "string"
            ? diag.messageText
            : diag.messageText.messageText,
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
        code: diag.code,
      });
    }
  }

  const TOLERATED_SYNTAX_CODES = new Set([
    1156, // "'let' declarations can only be declared inside a block"
    1313, // "The body of an 'if' statement cannot be the empty statement"
    1344, // "A label is not allowed here"
    1182, // "A destructuring declaration must have an initializer"
    1228, // "A type predicate is only allowed in return type position"
    1163, // "A 'yield' expression is only allowed in a generator body"
    1206, // "Decorators are not valid here"
    1207, // "Decorators cannot be applied to multiple get/set accessors"
    1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
    1436, // "Decorators must precede the name and all keywords of property declarations"
    1486, // "Decorator used before 'export' here"
    1497, // "Expression must be enclosed in parentheses to be used as a decorator"
    1498, // "Invalid syntax in decorator"
    8038, // "Decorators may not appear after 'export' or 'export default'"
    1184, // "Modifiers cannot appear here" (#537)
    1109, // "Expression expected" (#537)
    1135, // "Argument expression expected" (#537)
    1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" (#537)
    1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
    1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );

  if (hasSyntaxErrors && errors.length > 0) {
    return { object: new Uint8Array(0), success: false, errors };
  }

  let mod;
  try {
    const result = generateModule(ast);
    mod = result.module;
    for (const err of result.errors) {
      errors.push({
        message: err.message,
        line: err.line,
        column: err.column,
        severity: "error",
      });
    }
  } catch (e) {
    errors.push({
      message: `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return { object: new Uint8Array(0), success: false, errors };
  }

  let object: Uint8Array;
  try {
    object = emitObject(mod);
  } catch (e) {
    errors.push({
      message: `Object emit error: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return { object: new Uint8Array(0), success: false, errors };
  }

  return { object, success: true, errors };
}

/**
 * Hardened mode: walk AST and reject dangerous patterns.
 * Inspired by Endo/SES — compile-time rejection of insecure features.
 */
function validateHardenedMode(sourceFile: ts.SourceFile): Array<{ message: string; line: number; column: number; severity: "error" }> {
  const errors: Array<{ message: string; line: number; column: number; severity: "error" }> = [];

  function visit(node: ts.Node): void {
    // Reject eval() calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({ message: "[hardened] eval() is not allowed", line: line + 1, column: character, severity: "error" });
    }
    // Reject new Function()
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({ message: "[hardened] new Function() is not allowed", line: line + 1, column: character, severity: "error" });
    }
    // Reject with statements
    if (ts.isWithStatement(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({ message: "[hardened] with statement is not allowed", line: line + 1, column: character, severity: "error" });
    }
    // Reject __proto__ assignment
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "__proto__") {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        errors.push({ message: "[hardened] __proto__ assignment is not allowed", line: line + 1, column: character, severity: "error" });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

/**
 * Post-processing pass: widen all non-defaultable `ref` types to `ref_null`
 * throughout the module. This fixes two classes of Wasm validation errors:
 *
 * 1. "uninitialized non-defaultable local" -- locals with `ref $T` type have
 *    no implicit default value, so any code path that reads them before writing
 *    causes a validation error. Widening to `ref null $T` gives them a null default.
 *
 * 2. "struct.get/set expected type (ref null N), found ..." -- when function
 *    signatures use `ref` but callers/callees produce `ref_null` (or vice versa),
 *    the Wasm validator rejects the type mismatch. Consistently using `ref_null`
 *    in function types, locals, and globals avoids this.
 */
function widenNonDefaultableTypes(mod: WasmModule): void {
  function widenValType(t: ValType): ValType {
    return t.kind === "ref" ? { kind: "ref_null", typeIdx: t.typeIdx } : t;
  }

  // Widen all type definitions (func types, struct fields, array elements)
  function widenTypeDef(typeDef: typeof mod.types[number]): void {
    switch (typeDef.kind) {
      case "func":
        for (let i = 0; i < typeDef.params.length; i++) {
          typeDef.params[i] = widenValType(typeDef.params[i]!);
        }
        for (let i = 0; i < typeDef.results.length; i++) {
          typeDef.results[i] = widenValType(typeDef.results[i]!);
        }
        break;
      case "struct":
        for (const field of typeDef.fields) {
          field.type = widenValType(field.type);
        }
        break;
      case "array":
        typeDef.element = widenValType(typeDef.element);
        break;
      case "rec":
        for (const inner of typeDef.types) {
          widenTypeDef(inner);
        }
        break;
      case "sub":
        widenTypeDef(typeDef.type);
        break;
    }
  }

  for (const typeDef of mod.types) {
    widenTypeDef(typeDef);
  }

  // Widen function locals and block types in bodies
  for (const func of mod.functions) {
    for (const local of func.locals) {
      local.type = widenValType(local.type);
    }
    // Widen block types (if/block/loop/try) in instruction bodies
    widenBlockTypesInBody(func.body, widenValType);
  }

  // Widen global types
  for (const global of mod.globals) {
    global.type = widenValType(global.type);
  }

  // Widen import desc type for non-func imports (globals)
  for (const imp of mod.imports) {
    if (imp.desc.kind === "global") {
      imp.desc.type = widenValType(imp.desc.type);
    }
  }
}

/**
 * Recursively walk an instruction body and widen block types (if/block/loop/try)
 * from `ref` to `ref_null`, matching the widened function type signatures.
 */
function widenBlockTypesInBody(
  body: Instr[],
  widenValType: (t: ValType) => ValType,
): void {
  for (const instr of body) {
    const a = instr as any;
    // Widen block type if it's a val type with ref kind
    if (a.blockType && a.blockType.kind === "val") {
      a.blockType.type = widenValType(a.blockType.type);
    }
    // Recurse into nested instruction arrays
    if (a.then) widenBlockTypesInBody(a.then, widenValType);
    if (a.else) widenBlockTypesInBody(a.else, widenValType);
    if (a.body && Array.isArray(a.body)) widenBlockTypesInBody(a.body, widenValType);
    if (a.catches) {
      for (const c of a.catches) {
        if (c.body) widenBlockTypesInBody(c.body, widenValType);
      }
    }
    if (a.catchAll) widenBlockTypesInBody(a.catchAll, widenValType);
  }
}
