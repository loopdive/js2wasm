import ts from "typescript";
import type { CompileError, CompileOptions } from "../index.js";

// Default blocked members on extern classes in safe mode
const DEFAULT_BLOCKED_MEMBERS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "valueOf",
  "toString",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
]);

function getApproxSourceLocation(sourceFile: ts.SourceFile): { line: number; column: number } {
  const anchor = sourceFile.statements[0] ?? sourceFile;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function pushSourceAnchoredDiagnostic(
  errors: CompileError[],
  sourceFile: ts.SourceFile,
  message: string,
  severity: "error" | "warning",
): void {
  const loc = getApproxSourceLocation(sourceFile);
  errors.push({
    message,
    line: loc.line,
    column: loc.column,
    severity,
  });
}

/** Validate source against safe mode restrictions. Returns errors for violations. */
function validateSafeMode(sourceFile: ts.SourceFile, checker: ts.TypeChecker, options: CompileOptions): CompileError[] {
  const errors: CompileError[] = [];
  const allowedGlobals = new Set(options.allowedGlobals ?? []);
  const allowedMembers = options.allowedExternMembers ?? {};

  function pos(node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function visit(node: ts.Node): void {
    // 1. Check declare var/const globals
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText();
        // Block undeclared globals unless allowlisted
        if (!allowedGlobals.has(name)) {
          const p = pos(decl);
          errors.push({
            message: `Safe mode: declared global "${name}" is not in allowedGlobals`,
            line: p.line,
            column: p.column,
            severity: "error",
          });
        }
        // Block any type on declared globals
        if (decl.type) {
          const t = checker.getTypeAtLocation(decl.type);
          if (t.flags & ts.TypeFlags.Any) {
            const p = pos(decl.type);
            errors.push({
              message: `Safe mode: "any" type on declared global "${name}" is not allowed`,
              line: p.line,
              column: p.column,
              severity: "error",
            });
          }
        }
      }
    }

    // 2. Check declare class (extern class) members
    if (ts.isClassDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
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
            line: p.line,
            column: p.column,
            severity: "error",
          });
          continue;
        }

        // If an allowlist is provided for this class, check against it
        if (allowed && !allowed.includes(memberName)) {
          const p = pos(member);
          errors.push({
            message: `Safe mode: extern class "${className}" member "${memberName}" is not in allowedExternMembers`,
            line: p.line,
            column: p.column,
            severity: "error",
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
              line: p.line,
              column: p.column,
              severity: "error",
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
        const isDeclaredClass = decls.some(
          (d) => ts.isClassDeclaration(d) && d.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword),
        );
        if (isDeclaredClass) {
          const p = pos(node);
          errors.push({
            message: `Safe mode: dynamic property access on extern class "${objSymbol.getName()}" is not allowed`,
            line: p.line,
            column: p.column,
            severity: "error",
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
function detectEarlyErrors(sourceFile: ts.SourceFile): CompileError[] {
  const errors: CompileError[] = [];

  function pos(node: ts.Node): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return { line: line + 1, column: character + 1 };
  }

  function addError(node: ts.Node, message: string) {
    const p = pos(node);
    errors.push({ message, line: p.line, column: p.column, severity: "error" });
  }

  function findInnermostNodeAtPosition(node: ts.Node, position: number): ts.Node {
    let best: ts.Node = node;
    function visit(current: ts.Node): void {
      if (position < current.getFullStart() || position >= current.getEnd()) return;
      best = current;
      ts.forEachChild(current, visit);
    }
    visit(node);
    return best;
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
        // Don't assume module = strict. We add export {} synthetically for TS,
        // but the source may be a sloppy-mode script (test262 noStrict tests).
        return false;
      }
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
        return true;
      }
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
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
        (node.asteriskToken !== undefined || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))) ||
      params.some((p) => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name));
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
   * Check if an expression is NOT a valid assignment target per ES spec.
   * For simple assignment (=): identifiers, property/element access, and
   * destructuring patterns (object/array literals) are valid.
   * For update (++/--) and compound (+=, etc.): only identifiers and
   * property/element access are valid — no destructuring patterns.
   */
  function isInvalidAssignmentTarget(node: ts.Expression, allowDestructuring = false): boolean {
    let expr: ts.Node = node;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    // Valid: identifiers, property access, element access
    if (ts.isIdentifier(expr)) return false;
    if (ts.isPropertyAccessExpression(expr)) return false;
    if (ts.isElementAccessExpression(expr)) return false;
    // Valid only in simple assignment: destructuring patterns
    if (allowDestructuring) {
      if (ts.isObjectLiteralExpression(expr)) return false;
      if (ts.isArrayLiteralExpression(expr)) return false;
    }
    // Everything else is invalid
    return true;
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
    if (
      (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr) || ts.isCallExpression(expr)) &&
      (expr as any).questionDotToken
    ) {
      return true;
    }
    // Check parent chain for optional chaining context
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      return hasOptionalChain(expr.expression);
    }
    return false;
  }

  function isUsingDeclarationStatement(node: ts.Node): node is ts.VariableStatement {
    if (!ts.isVariableStatement(node)) return false;
    return (node.declarationList.flags & ts.NodeFlags.Using) !== 0;
  }

  function visit(node: ts.Node): void {
    // Check prefix/postfix increment/decrement on arguments/eval in strict mode
    // Also check increment/decrement on optional chaining (always invalid)
    // Also check increment/decrement on non-simple assignment targets
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
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

    if (
      ts.isPostfixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
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
      // ES spec: no LineTerminator between LeftHandSideExpression and ++/--.
      // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) between
      // operand and operator are SyntaxErrors. Regular \n and \r are handled
      // by the TS parser's ASI, but these Unicode separators are not.
      const operandEnd = node.operand.end;
      const opStart = node.operand.end; // operator immediately follows operand in AST
      const textBetween = sourceFile.text.substring(operandEnd, node.end - 2);
      if (/[\u2028\u2029]/.test(textBetween)) {
        addError(node, "No line terminator allowed before postfix operator");
      }
    }

    // Check assignment to arguments/eval in strict mode
    // Also check assignment to non-simple targets
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = isArgumentsOrEval(node.left);
      if (name && isStrictMode(node)) {
        addError(node.left, `Cannot assign to '${name}' in strict mode`);
      }
      if (hasOptionalChain(node.left)) {
        addError(node, "Optional chaining is not valid in the left-hand side of an assignment expression");
      }
      if (isInvalidAssignmentTarget(node.left, /* allowDestructuring */ true)) {
        addError(node, "Invalid left-hand side in assignment");
      }
      // When LHS is an array or object literal, validate it as an AssignmentPattern
      const lhs = node.left;
      if (ts.isArrayLiteralExpression(lhs)) {
        validateArrayAssignmentPattern(lhs, isStrictMode(node));
      } else if (ts.isObjectLiteralExpression(lhs)) {
        validateObjectAssignmentPattern(lhs, isStrictMode(node));
      }
    }

    // Check compound assignment to arguments/eval in strict mode
    // Also check logical assignment (&&=, ||=, ??=) to non-simple targets
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const compoundOps = [
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
        ts.SyntaxKind.PercentEqualsToken,
        ts.SyntaxKind.AmpersandEqualsToken,
        ts.SyntaxKind.BarEqualsToken,
        ts.SyntaxKind.CaretEqualsToken,
        ts.SyntaxKind.LessThanLessThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
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
        if (hasOptionalChain(node.left)) {
          addError(node, "Optional chaining is not valid in the left-hand side of an assignment expression");
        }
        // Compound assignment to non-simple targets (call expressions, binary, etc.)
        if (isInvalidAssignmentTarget(node.left)) {
          addError(node, "Invalid left-hand side in assignment");
        }
      }
    }

    // Check for-in/for-of with non-simple assignment target as LHS
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      const lhs = node.initializer as ts.Expression;
      if (isInvalidAssignmentTarget(lhs, /* allowDestructuring */ true)) {
        addError(node.initializer, "Invalid left-hand side in for-in/for-of");
      }
      // When LHS is an array or object literal, validate it as AssignmentPattern
      if (ts.isArrayLiteralExpression(lhs)) {
        validateArrayAssignmentPattern(lhs, isStrictMode(node));
      } else if (ts.isObjectLiteralExpression(lhs)) {
        validateObjectAssignmentPattern(lhs, isStrictMode(node));
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
      // ── Arrow function ASI restriction ────────────────────────────
      // ES spec: ArrowFunction : ArrowParameters [no LineTerminator here] => ConciseBody
      // If there is a LineTerminator between parameters and =>, it is a SyntaxError.
      // TypeScript's parser handles this but may still produce an ArrowFunction node.
      // Check by looking at the source text between end of params and the => token.
      if (node.equalsGreaterThanToken) {
        const paramsEnd = node.parameters.end;
        const arrowStart = node.equalsGreaterThanToken.getStart(sourceFile);
        const textBetween = sourceFile.text.substring(paramsEnd, arrowStart);
        if (/[\r\n\u2028\u2029]/.test(textBetween)) {
          addError(node, "Arrow function parameters and '=>' must be on the same line");
        }
      }
    }
    if (ts.isMethodDeclaration(node) && node.parameters) {
      checkDuplicateParams(node.parameters, node);
    }

    // ── YieldExpression in generator default parameters ──────────────
    // ES spec: It is a SyntaxError if FormalParameters of a generator
    // function Contains YieldExpression. Default parameter values are
    // evaluated before the generator body, so yield is not valid there.
    // Same applies to async generators (AwaitExpression in params).
    if (ts.isYieldExpression(node)) {
      if (isInsideGeneratorParams(node)) {
        addError(node, "Yield expression is not allowed in generator function parameters");
      }
    }
    if (ts.isAwaitExpression(node)) {
      if (isInsideAsyncParams(node)) {
        addError(node, "Await expression is not allowed in async function parameters");
      }
    }

    // Check yield used as identifier in generator functions/methods
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "yield") {
      // Check if inside a generator function/method
      let parent: ts.Node | undefined = node.parent;
      while (parent) {
        if (
          ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.asteriskToken) ||
          (ts.isMethodDeclaration(parent) && parent.asteriskToken)
        ) {
          addError(node.name, "'yield' is a reserved word and cannot be used as an identifier in generator functions");
          break;
        }
        if (
          ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isArrowFunction(parent) ||
          ts.isMethodDeclaration(parent)
        ) {
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

    // Check var redeclaration conflicts with lexical declarations in block/module scope
    // ES spec: It is a Syntax Error if any element of VarDeclaredNames also occurs
    // in LexicallyDeclaredNames of the StatementList.
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      checkVarLexicalConflicts(node);
    }

    // Check TDZ violations for let/const in block-like scopes
    // These are also caught by TS checker (2448/2474) as downgraded warnings.
    // We emit them as warnings here so compilation continues — tests expect runtime ReferenceError.
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const stmts = ts.isSourceFile(node) ? node.statements : ts.isBlock(node) ? node.statements : node.statements;
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
      let operand: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(operand)) {
        operand = operand.expression;
      }
      if (ts.isIdentifier(operand)) {
        addError(node, `Delete of an unqualified identifier in strict mode`);
      }
    }

    // Check 'delete' on private names — always a SyntaxError
    // ES spec: delete MemberExpression.PrivateName and delete CallExpression.PrivateName
    // are early errors (class bodies are always strict mode).
    // Covers: delete this.#x, delete (this.#x), delete g().#x, delete (g().#x)
    if (ts.isDeleteExpression(node)) {
      let operand: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(operand)) {
        operand = operand.expression;
      }
      if (ts.isPropertyAccessExpression(operand) && ts.isPrivateIdentifier(operand.name)) {
        addError(node, `Deleting a private field is a SyntaxError`);
      }
    }

    // Check for-in loop with initializer — SyntaxError in strict mode for var,
    // always a SyntaxError for let/const (ES2015+)
    // Also: var with destructuring pattern + initializer is always SyntaxError (Annex B)
    if (ts.isForInStatement(node)) {
      const init = node.initializer;
      if (ts.isVariableDeclarationList(init)) {
        const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
        // ES spec: 'using' declarations are not allowed in for-in (only for-of)
        const isUsing = (init.flags & ts.NodeFlags.Using) !== 0;
        if (isUsing) {
          addError(node, "'using' declarations are not allowed in for-in loops");
        } else {
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
    }

    // Check for-of loop: declarations may not have initializers; lexical must be single binding
    // ES spec: ForInOfStatement: for (var ForBinding of AssignmentExpression) — no initializer.
    // Also for let/const: no initializer and only one binding.
    if (ts.isForOfStatement(node)) {
      const init = node.initializer;
      if (ts.isVariableDeclarationList(init)) {
        const isLexical = (init.flags & ts.NodeFlags.Let) !== 0 || (init.flags & ts.NodeFlags.Const) !== 0;
        const isUsing = (init.flags & ts.NodeFlags.Using) !== 0;
        // Both var and lexical: no initializers allowed
        for (const decl of init.declarations) {
          if (decl.initializer) {
            addError(node, "for-of loop head declarations may not have initializers");
            break;
          }
        }
        if (isLexical && init.declarations.length > 1) {
          addError(node, "Only a single declaration is allowed in a for-of statement");
        }
        // ES spec: BoundNames of ForDeclaration may not contain duplicates (for-of const)
        if (isLexical) {
          const seen = new Set<string>();
          const dupes = new Set<string>();
          for (const decl of init.declarations) {
            collectBindingNamesWithDuplicateCheck(decl.name, seen, dupes);
          }
          for (const name of dupes) {
            addError(node, `Duplicate binding '${name}' in for-of declaration`);
          }
        }
        // ES spec: BoundNames of using ForDeclaration may not contain "let"
        if (isUsing) {
          for (const decl of init.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === "let") {
              addError(decl.name, "Using declarations may not bind 'let'");
            }
          }
          // ES spec: BoundNames of using must not conflict with body var declarations
          const boundNames = new Set<string>();
          for (const decl of init.declarations) {
            if (ts.isIdentifier(decl.name)) boundNames.add(decl.name.text);
          }
          if (boundNames.size > 0 && ts.isBlock(node.statement)) {
            collectVarDeclaredNamesInBlock(node.statement, boundNames);
          }
        }
      }
      // ES spec: `for (async of ...)` - `async` as LHS before `of` is a SyntaxError
      if (!ts.isVariableDeclarationList(node.initializer) && ts.isIdentifier(node.initializer)) {
        if (node.initializer.text === "async") {
          addError(node.initializer, "'async' is not allowed as a left-hand side identifier in for-of");
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
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.parameters.length > 0
    ) {
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
        const isPropertyName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node) ||
            (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isEnumMember(parent) && parent.name === node) ||
            (ts.isPropertySignature(parent) && parent.name === node) ||
            (ts.isMethodSignature(parent) && parent.name === node));
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
        "implements",
        "interface",
        "package",
        "private",
        "protected",
        "public",
        "static",
      ]);
      if (strictReserved.has(node.text)) {
        // Skip property names — they're fine in strict mode
        const parent = node.parent;
        const isPropertyName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node) ||
            (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isPropertySignature(parent) && parent.name === node) ||
            (ts.isMethodSignature(parent) && parent.name === node));
        // Also skip if used as a label name (label: statement)
        const isLabel = parent && ts.isLabeledStatement(parent) && parent.label === node;
        // Skip break/continue target labels
        const isBreakContinueTarget =
          parent &&
          ((ts.isBreakStatement(parent) && parent.label === node) ||
            (ts.isContinueStatement(parent) && parent.label === node));
        if (!isPropertyName && !isLabel && !isBreakContinueTarget) {
          // Flag when used as a binding name (variable, parameter, function name)
          // or as a shorthand property (IdentifierReference context)
          const isBinding =
            parent &&
            ((ts.isVariableDeclaration(parent) && parent.name === node) ||
              (ts.isParameter(parent) && parent.name === node) ||
              (ts.isFunctionDeclaration(parent) && parent.name === node) ||
              (ts.isFunctionExpression(parent) && parent.name === node) ||
              (ts.isClassDeclaration(parent) && parent.name === node) ||
              (ts.isClassExpression(parent) && parent.name === node) ||
              (ts.isBindingElement(parent) && parent.name === node) ||
              // Shorthand property in object literal: {implements} — IdentifierReference
              (ts.isShorthandPropertyAssignment(parent) && parent.name === node));
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
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body)
    ) {
      const hasNonSimpleParams = node.parameters.some(
        (p) => p.initializer !== undefined || p.dotDotDotToken !== undefined || !ts.isIdentifier(p.name), // destructuring pattern
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
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body)
    ) {
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
    // Exception: `declare const x: T` — ambient declarations have no initializer
    // by design (they describe external bindings, not local variables). These are
    // generated by preprocessImports for unused imported bindings (#951).
    if (ts.isVariableDeclaration(node) && !node.initializer) {
      const declList = node.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        const declListParent = declList.parent;
        const isForOfOrIn =
          declListParent && (ts.isForOfStatement(declListParent) || ts.isForInStatement(declListParent));
        const isAmbient =
          ts.isVariableStatement(declListParent) &&
          declListParent.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
        if (!isForOfOrIn && !isAmbient) {
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
            const body = ts.isForStatement(node)
              ? node.statement
              : ts.isForInStatement(node)
                ? node.statement
                : node.statement;
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
      const isBinding =
        parent &&
        ((ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isParameter(parent) && parent.name === node) ||
          (ts.isFunctionDeclaration(parent) && parent.name === node) ||
          (ts.isFunctionExpression(parent) && parent.name === node) ||
          (ts.isClassDeclaration(parent) && parent.name === node) ||
          (ts.isClassExpression(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.name === node) ||
          (ts.isCatchClause(parent) &&
            parent.variableDeclaration &&
            ts.isIdentifier(parent.variableDeclaration.name) &&
            parent.variableDeclaration.name === node));
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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (member.name && !ts.isPrivateIdentifier(member.name)) {
          const isStatic = ts.canHaveModifiers(member)
            ? (ts.getModifiers(member as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
            : false;
          if (isStatic) {
            const memberName = ts.isIdentifier(member.name)
              ? member.name.text
              : ts.isStringLiteral(member.name)
                ? member.name.text
                : null;
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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      checkDuplicatePrivateNames(node);
    }

    // ── Private name `#constructor` is always forbidden ───────────────
    // ES spec: ClassElementName : PrivateName
    //   It is a Syntax Error if StringValue of PrivateName is "#constructor".
    // This applies to fields, methods, getters, setters regardless of static.
    if (ts.isPrivateIdentifier(node) && node.text === "#constructor") {
      addError(node, "Private field '#constructor' is not allowed");
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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        const memberName = getMemberName(member);
        if (memberName === "constructor") {
          const isStaticMember = (member as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.StaticKeyword);
          if (isStaticMember) continue; // static "constructor" is fine
          if (ts.isMethodDeclaration(member) && member.asteriskToken) {
            addError(member, "Class constructor may not be a generator");
          }
          if (
            ts.isMethodDeclaration(member) &&
            member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)
          ) {
            addError(member, "Class constructor may not be an async method");
          }
          if (ts.isGetAccessorDeclaration(member)) {
            addError(member, "Class constructor may not be a getter");
          }
          if (ts.isSetAccessorDeclaration(member)) {
            addError(member, "Class constructor may not be a setter");
          }
        }
        // TS parses `async constructor()` as a ConstructorDeclaration with
        // AsyncKeyword modifier (not as a MethodDeclaration named "constructor").
        // Catch this case separately.
        if (ts.isConstructorDeclaration(member)) {
          if (member.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            addError(member, "Class constructor may not be an async method");
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
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      node.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      if (!isInsideMethod(node)) {
        addError(node, "'super' keyword unexpected here");
      }
      // ES spec: SuperProperty only allows IdentifierName and [Expression],
      // NOT PrivateName. super.#x is always a SyntaxError.
      if (ts.isPropertyAccessExpression(node) && ts.isPrivateIdentifier(node.name)) {
        addError(node, "Private fields cannot be accessed via super");
      }
    }

    // ── Strict mode reserved words as assignment targets ─────────────
    // ES spec: It is a SyntaxError if the LeftHandSideExpression of a simple
    // assignment is a strict mode reserved word (public, private, protected, etc.)
    // and the code is in strict mode.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isStrictMode(node)) {
      let lhs: ts.Node = node.left;
      while (ts.isParenthesizedExpression(lhs)) lhs = lhs.expression;
      if (ts.isIdentifier(lhs)) {
        const strictReservedAssign = new Set([
          "implements",
          "interface",
          "let",
          "package",
          "private",
          "protected",
          "public",
          "static",
          "yield",
        ]);
        if (strictReservedAssign.has(lhs.text)) {
          addError(lhs, `Assignment to reserved word '${lhs.text}' in strict mode`);
        }
      }
    }

    // ── Duplicate __proto__ in object literal ────────────────────────
    if (ts.isObjectLiteralExpression(node)) {
      let protoCount = 0;
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const propName = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : null;
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
            if (
              ts.isExpressionStatement(stmt) &&
              ts.isStringLiteral(stmt.expression) &&
              stmt.expression.text === "use strict"
            ) {
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

    // ── Duplicate labels in class static blocks ────────────────────
    // ES spec: ClassStaticBlockBody — It is a Syntax Error if
    // ContainsDuplicateLabels of ClassStaticBlockStatementList is true.
    if (ts.isClassStaticBlockDeclaration(node)) {
      checkDuplicateLabelsInBlock(node.body);
    }

    // ── break/continue outside valid context ──────────────────────────
    // TS catches these as semantic errors (1104, 1105) but we skip semantic
    // diagnostics in the test262 worker, so detect them here.
    if (ts.isContinueStatement(node)) {
      if (!isInsideIteration(node, node.label?.text)) {
        addError(
          node,
          node.label
            ? `A 'continue' statement can only jump to a label of an enclosing iteration statement`
            : `A 'continue' statement can only be used within an enclosing iteration statement`,
        );
      }
    }
    if (ts.isBreakStatement(node)) {
      if (!isInsideBreakable(node, node.label?.text)) {
        addError(
          node,
          node.label
            ? `A 'break' statement can only jump to a label of an enclosing statement`
            : `A 'break' statement can only be used within an enclosing iteration or switch statement`,
        );
      }
    }

    // ── new import() — always a SyntaxError ────────────────────────
    // ES spec: ImportCall is a CallExpression, not a NewExpression target.
    // Also applies to import.source() and import.defer() proposals.
    // TS parser splits "new import('x')" into a broken NewExpression (empty identifier)
    // followed by an import CallExpression. We detect this by checking for
    // NewExpression with a missing/empty expression where the source text shows "new import".
    if (ts.isNewExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === "") {
        const start = node.getStart(sourceFile);
        const textAfter = sourceFile.text.substring(start, start + 30);
        if (/^new\s+import\s*[\.(]/.test(textAfter)) {
          addError(node, "Cannot use new with import()");
        }
      }
    }

    // ── typeof import — always a SyntaxError ────────────────────────
    // ES spec: `import` is not a valid UnaryExpression operand (not an identifier).
    // TS parser creates a TypeOfExpression with an empty Identifier when parsing
    // `typeof import`. Detect this by checking source text.
    if (ts.isTypeOfExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === "") {
        const start = node.getStart(sourceFile);
        const textAfter = sourceFile.text.substring(start, start + 30);
        if (/^typeof\s+import\b/.test(textAfter)) {
          addError(node, "Cannot use typeof with import");
        }
      }
    }

    // ── `arguments` in class field initializers ──────────────────────
    // ES spec: FieldDefinition — It is a Syntax Error if ContainsArguments
    // of Initializer is true. `arguments` is not allowed in any class field
    // initializer (instance or static), because field initializers are not
    // "real" function bodies and don't bind `arguments`.
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) {
        if (containsArguments(node.initializer)) {
          addError(node.initializer, "'arguments' is not allowed in class field initializers");
        }
      }
    }

    // ── `arguments` in class static blocks ──────────────────────────
    // ES spec: ClassStaticBlockBody — It is a Syntax Error if
    // ContainsArguments of ClassStaticBlockStatementList is true.
    if (ts.isClassStaticBlockDeclaration(node)) {
      if (containsArguments(node.body)) {
        addError(node, "'arguments' is not allowed in class static initialization blocks");
      }
    }

    // ── await with empty operand in async functions ───────────────
    // When TS parses `void await`, `await:`, or just `await` (as identifier ref)
    // inside an async function, it creates AwaitExpression with empty Identifier
    // operand. This means `await` was used as an identifier, not as the keyword.
    // ES spec: await is a reserved word in async function bodies.
    if (ts.isAwaitExpression(node)) {
      const operand = node.expression;
      if (ts.isIdentifier(operand) && operand.text === "") {
        if (isInsideAsyncFunction(node) || isInsideClassStaticBlock(node)) {
          addError(node, "'await' is not allowed as an identifier in this context");
        }
      }
      // Also check await: label pattern (TS parses await: as AwaitExpression + colon)
      if (isInsideAsyncFunction(node) || isInsideClassStaticBlock(node)) {
        const endPos = node.end;
        const afterText = sourceFile.text.substring(endPos, endPos + 5).trimStart();
        if (afterText.startsWith(":")) {
          addError(node, "'await' is not allowed as a label identifier in this context");
        }
      }
      // ES spec: ClassStaticBlockBody: "It is a Syntax Error if ContainsAwait
      // of ClassStaticBlockStatementList is true." This means a real AwaitExpression
      // (not just the identifier 'await') inside a static block is always invalid,
      // even if the static block is nested inside an async function.
      if (isInsideClassStaticBlock(node)) {
        addError(node, "'await' is not allowed in class static initialization blocks");
      }
      // ES spec: AwaitExpression is only valid in async functions or module top-level.
      // In module context, TypeScript may produce AwaitExpression for `await 1` inside
      // a regular (non-async) function. That's a SyntaxError per ES spec because the
      // function uses [~Await] formal parameters/body.
      // NOTE: We use isInsideNestedFunction (not isInsideAnyFunction) to avoid false
      // positives from the test262 runner, which wraps module code in
      // `export function test() { ... }`. Code at "module top level" in tests thus
      // appears inside test() (1 function deep). Real nested functions like
      // `function fn() { await 0; }` inside the wrapper are 2+ levels deep.
      // See the same trade-off comment at line ~1492 (import/export in invalid positions).
      if (!isInsideAsyncFunction(node) && !isInsideClassStaticBlock(node) && isInsideNestedFunction(node)) {
        addError(node, "'await' expressions are only allowed in async functions");
      }
    }

    // ── yield with empty operand in generator functions ──────────
    // Similar to await: when `yield` is used as identifier reference in a generator,
    // TS may create YieldExpression with empty operand.
    if (ts.isYieldExpression(node) && isInsideGeneratorFunction(node)) {
      const operand = node.expression;
      if (operand && ts.isIdentifier(operand) && operand.text === "") {
        addError(node, "'yield' is not allowed as an identifier in a generator function");
      }
    }

    // ── yield * with newline before * ──────────────────────────────
    // ES spec: YieldExpression : yield [no LineTerminator here] * AssignmentExpression
    // A newline before the `*` makes it a distinct statement — SyntaxError.
    if (ts.isYieldExpression(node) && node.asteriskToken && isInsideGeneratorFunction(node)) {
      const yieldEnd = node.getStart(sourceFile) + 5; // length of "yield"
      const starStart = node.asteriskToken.getStart(sourceFile);
      const textBetween = sourceFile.text.substring(yieldEnd, starStart);
      if (/[\r\n\u2028\u2029]/.test(textBetween)) {
        addError(node, "A newline may not precede the '*' token in a yield expression");
      }
    }

    // ── yield in class static blocks ──────────────────────────────
    // ES spec: ClassStaticBlockStatementList uses [~Yield], meaning yield
    // is not allowed inside static blocks even if nested within a generator.
    // TS parses `yield;` in static blocks as Identifier("yield"), not
    // YieldExpression, because class bodies are strict mode. TS diagnostic
    // 1214 is downgraded for sloppy-mode compat, so check explicitly.
    if (ts.isIdentifier(node) && node.text === "yield") {
      if (isInsideClassStaticBlock(node) && !isInsideGeneratorFunction(node)) {
        const parent = node.parent;
        // Skip property names (obj.yield, { yield: x })
        const isPropertyName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node));
        if (!isPropertyName) {
          addError(node, "'yield' is not allowed in class static initialization blocks");
        }
      }
    }

    // ── Escaped keyword detection ─────────────────────────────────
    // ES spec: Keywords containing Unicode escape sequences are not valid.
    // e.g., \u0061wait is NOT a valid `await` keyword, im\u0070ort is NOT
    // a valid `import` keyword, etc.
    // Check if the raw source text of keyword-like nodes contains \u escapes.
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      const start = node.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 10);
      if (/\\u[0-9a-fA-F]{4}/.test(rawText)) {
        addError(node, "Keyword must not contain escaped characters");
      }
    }
    // Escaped 'async' modifier
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      for (const mod of node.modifiers!) {
        if (mod.kind === ts.SyntaxKind.AsyncKeyword) {
          const modStart = mod.getStart(sourceFile);
          const rawText = sourceFile.text.substring(modStart, modStart + 10);
          if (/\\u[0-9a-fA-F]{4}/.test(rawText)) {
            addError(mod, "Keyword must not contain escaped characters");
          }
        }
      }
    }

    // ── Escaped reserved/contextual keywords in export/import ──────
    // ES spec: It is a SyntaxError if the source text of an IdentifierName
    // in keyword position contains a UnicodeEscapeSequence.
    // Covers: `export { x \u0061s y }`, `export { x as \u0064efault }`,
    //         `export {} \u0066rom "./x"`, etc.
    if (ts.isExportDeclaration(node) || ts.isImportDeclaration(node)) {
      const nodeStart = node.getStart(sourceFile);
      const nodeText = sourceFile.text.substring(nodeStart, node.end);
      if (nodeText.includes("\\u")) {
        addError(node, "Keyword must not contain escaped characters");
      }
    }
    if (ts.isExportSpecifier(node)) {
      // Check the exported name and the local name for escaped keywords
      const checkEscape = (n: ts.Identifier | ts.StringLiteral) => {
        const s = n.getStart(sourceFile);
        const raw = sourceFile.text.substring(s, s + n.text.length + 10);
        if (raw.includes("\\u")) {
          addError(n, "Keyword must not contain escaped characters");
        }
      };
      checkEscape(node.name);
      if (node.propertyName) checkEscape(node.propertyName);
    }

    // ── import/export in invalid positions ──────────────────────────
    // NOTE: These checks are intentionally REMOVED (#952).
    // Our test262 runner wraps module tests inside `export function test() { try { ... } }`,
    // which places import/export declarations inside a function body. TypeScript's parser
    // doesn't flag this (it's a semantic error, code 1258), and the compiler handles it
    // gracefully. Re-adding these checks would cause ~97 test regressions.
    // TypeScript semantic diagnostics (1258, 1232) catch real cases if needed.

    // ── dynamic import() as assignment target ──────────────────────
    // ES spec: ImportCall is not a valid LeftHandSideExpression for assignment.
    // e.g., import('x')++, import('x') = 1, ++import('x')
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const parent = node.parent;
      if (parent) {
        // import()++ or import()--
        if (ts.isPostfixUnaryExpression(parent) && parent.operand === node) {
          addError(node, "Invalid left-hand side in postfix operation");
        }
        // ++import() or --import()
        if (
          ts.isPrefixUnaryExpression(parent) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) &&
          parent.operand === node
        ) {
          addError(node, "Invalid left-hand side expression in prefix operation");
        }
        // import() = x
        if (
          ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          addError(node, "Invalid left-hand side in assignment");
        }
      }
    }

    // ── await in class static initializer blocks ──────────────────
    // ES spec: It is a Syntax Error if the code matched by this production is
    // nested within a ClassStaticBlock and StringValue of Identifier is "await".
    if (ts.isIdentifier(node) && node.text === "await") {
      if (isInsideClassStaticBlock(node) && !isInsideAsyncFunction(node)) {
        const parent = node.parent;
        // Skip property names
        const isPropertyName =
          parent &&
          ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node));
        if (!isPropertyName) {
          addError(node, "'await' is not allowed as an identifier in a class static initializer block");
        }
      }
    }

    // ── return outside function ──────────────────────────────────
    // ES spec: A ReturnStatement can only appear in a FunctionBody.
    // ES spec: ClassStaticBlockStatementList uses [~Return], meaning
    // 'return' is not valid directly inside a static block even if the
    // block is nested inside a function. Only returns inside functions
    // WITHIN the static block are valid.
    if (ts.isReturnStatement(node)) {
      if (!isInsideFunction(node)) {
        addError(node, "A 'return' statement can only be used within a function body");
      } else if (isInsideClassStaticBlock(node)) {
        addError(node, "A 'return' statement is not allowed in a class static initialization block");
      }
    }

    // ── yield-as-label (TS parses yield: as YieldExpression in generators)
    // Only flag if the colon is a label colon, not a ternary operator colon.
    // A ternary colon is preceded by `?` somewhere before it. Check if the
    // yield is the consequent/alternate of a ConditionalExpression.
    if (ts.isYieldExpression(node) && isInsideGeneratorFunction(node)) {
      const endPos = node.end;
      const afterText = sourceFile.text.substring(endPos, endPos + 5).trimStart();
      if (afterText.startsWith(":")) {
        // Don't flag if the yield is inside a ConditionalExpression (ternary ? yield : ...)
        const isInTernary =
          node.parent &&
          (ts.isConditionalExpression(node.parent) ||
            // Also check grandparent for nested parens: (yield) ? yield : yield
            (ts.isParenthesizedExpression(node.parent) && ts.isConditionalExpression(node.parent.parent)));
        if (!isInTernary) {
          addError(node, "'yield' is not allowed as a label identifier in a generator function");
        }
      }
    }

    // ── Escaped 'let' keyword ─────────────────────────────────────
    // \u006Cet is not valid as a keyword
    if (ts.isIdentifier(node) && node.text === "let") {
      const start = node.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 10);
      if (rawText.includes("\\u")) {
        addError(node, "Keyword must not contain escaped characters");
      }
    }

    // ── private name escape sequences ─────────────────────────────
    // ES spec: It is a Syntax Error if any code point in the PrivateIdentifier
    // is expressed by a UnicodeEscapeSequence, unless it's for a valid start/part.
    // For keywords like 'async', 'generator', 'field' — private names with
    // escape sequences like #\u0061sync are SyntaxErrors.
    // Note: TS represents private identifiers with ts.isPrivateIdentifier.
    // The "cannot-escape-token" tests check that keywords used in private name
    // positions cannot use Unicode escapes.

    // ── Duplicate export names ────────────────────────────────────
    // ES spec: It is a Syntax Error if the ExportedNames of ModuleBody contains
    // any duplicate entries.
    // This is checked at the source file level.

    // ── import() argument validation ──────────────────────────────
    // ES spec: ImportCall takes exactly one AssignmentExpression (plus an
    // optional second options argument per the import-attributes proposal).
    // import() with 0 args, spread args, or 3+ args is a SyntaxError.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 0) {
        addError(node, "import() requires at least one argument");
      }
      for (const arg of node.arguments) {
        if (ts.isSpreadElement(arg)) {
          addError(arg, "import() does not allow spread arguments");
        }
      }
    }

    // ── Escaped 'import' keyword in dynamic import() ──────────────
    // im\u0070ort('x') — escaped form of import keyword is not valid
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const start = node.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 15);
      if (rawText.includes("\\u")) {
        addError(node, "Keyword must not contain escaped characters");
      }
    }

    // ── VoidExpression / TypeOfExpression with empty operand ─────────
    // When TS encounters `void yield` or `void await` in a generator/async context,
    // it splits them into two statements: void(empty) and yield/await.
    // The void/typeof gets an empty Identifier operand (text === "").
    // In ES spec, `void` always requires a UnaryExpression, so this indicates
    // a parse issue — the construct is a SyntaxError.
    if (ts.isVoidExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === "") {
        // Check what follows in the source — likely `void yield` or `void await`
        const start = node.getStart(sourceFile);
        const rawText = sourceFile.text.substring(start, start + 20).trim();
        if (/^void\s+(yield|await)\b/.test(rawText)) {
          addError(node, `'${rawText.match(/void\s+(\w+)/)?.[1]}' is not a valid operand for 'void' in this context`);
        }
      }
    }
    if (ts.isTypeOfExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === "") {
        const start = node.getStart(sourceFile);
        const rawText = sourceFile.text.substring(start, start + 25).trim();
        if (/^typeof\s+(yield|await)\b/.test(rawText)) {
          addError(
            node,
            `'${rawText.match(/typeof\s+(\w+)/)?.[1]}' is not a valid operand for 'typeof' in this context`,
          );
        }
      }
    }

    // ── Unary prefix (+, -, ~, !) with yield/await in generator/async ──
    // Same issue: `+yield`, `-yield`, etc. TS splits the expression.
    // If a PrefixUnaryExpression (not ++/--) has an empty Identifier operand,
    // check if it's followed by yield/await.
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator !== ts.SyntaxKind.PlusPlusToken &&
      node.operator !== ts.SyntaxKind.MinusMinusToken
    ) {
      const operand = node.operand;
      if (ts.isIdentifier(operand) && operand.text === "") {
        const start = node.getStart(sourceFile);
        const rawText = sourceFile.text.substring(start, start + 20).trim();
        if (/^[+\-~!]\s*(yield|await)\b/.test(rawText)) {
          addError(node, `Invalid use of '${rawText.match(/[+\-~!]\s*(\w+)/)?.[1]}' in this context`);
        }
      }
    }

    // ── Nullish coalescing (??) mixed with || or && without parens ──
    // ES spec: It is a Syntax Error if ShortCircuitExpression includes both
    // CoalesceExpression (??) and LogicalORExpression/LogicalANDExpression
    // without explicit parenthesization.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken) {
        // Check if either child is a || or && expression (without parens)
        const checkMixed = (child: ts.Node): boolean => {
          if (ts.isParenthesizedExpression(child)) return false; // parens break the chain
          if (ts.isBinaryExpression(child)) {
            const childOp = child.operatorToken.kind;
            if (childOp === ts.SyntaxKind.BarBarToken || childOp === ts.SyntaxKind.AmpersandAmpersandToken) {
              return true;
            }
          }
          return false;
        };
        if (checkMixed(node.left) || checkMixed(node.right)) {
          addError(node, "Cannot mix '??' with '||' or '&&' without parentheses");
        }
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const checkMixed = (child: ts.Node): boolean => {
          if (ts.isParenthesizedExpression(child)) return false;
          if (ts.isBinaryExpression(child)) {
            if (child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return true;
          }
          return false;
        };
        if (checkMixed(node.left) || checkMixed(node.right)) {
          addError(node, "Cannot mix '??' with '||' or '&&' without parentheses");
        }
      }
    }

    // ── Optional chaining with tagged template literal ───────────────
    // ES spec: OptionalChain : ?.TemplateLiteral and OptionalChain TemplateLiteral
    // are always SyntaxErrors. Tagged templates cannot be used with optional chaining.
    if (ts.isTaggedTemplateExpression(node)) {
      // Check if the tag uses optional chaining
      if (hasOptionalChain(node.tag)) {
        addError(node, "Tagged template cannot be used in an optional chain");
      }
      // Also check for direct ?.` pattern: a?.`hello`
      const tagEnd = node.tag.end;
      const textBetween = sourceFile.text.substring(tagEnd - 2, tagEnd + 2);
      if (textBetween.includes("?.")) {
        addError(node, "Tagged template cannot be used in an optional chain");
      }
    }

    // ── new.target outside function ─────────────────────────────────
    // ES spec: new.target is only valid inside functions (including arrow functions
    // which inherit from enclosing function) and class static blocks.
    if (node.kind === ts.SyntaxKind.MetaProperty) {
      const meta = node as ts.MetaProperty;
      if (meta.keywordToken === ts.SyntaxKind.NewKeyword && meta.name.text === "target") {
        if (!isInsideFunction(node) && !isInsideClassStaticBlock(node)) {
          addError(node, "new.target is only valid inside functions");
        }
      }
    }

    // ── super() in constructor of class without extends ──────────────
    // ES spec: It is a Syntax Error if ConstructorMethod of ClassBody contains
    // SuperCall and ClassHeritage is not present.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      // Find the enclosing class
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (ts.isConstructorDeclaration(current)) {
          const classNode = current.parent;
          if (
            (ts.isClassDeclaration(classNode) || ts.isClassExpression(classNode)) &&
            !classNode.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
          ) {
            addError(node, "super() is only valid in a constructor of a derived class");
          }
          break;
        }
        if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
          break;
        }
        current = current.parent;
      }
    }

    // ── ASI: postfix ++/-- with line terminator before operator ─────
    // ES spec: no LineTerminator between LeftHandSideExpression and ++/--.
    // If a line terminator separates the operand from the operator, ASI applies
    // and the ++ is parsed as a prefix on the next line. But if there's no
    // next operand, it's a SyntaxError.
    // NOTE: This only applies to LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029)
    // because regular \n and \r are handled by TS parser's ASI behavior.
    // After wrapTest resolves Unicode escapes, these characters appear literally.

    // ── 'using' / 'await using' placement restrictions ───────────────
    if (isUsingDeclarationStatement(node)) {
      const parent = node.parent;
      if (parent && (ts.isCaseClause(parent) || ts.isDefaultClause(parent))) {
        addError(node, "Using declarations cannot appear directly in switch case/default statement lists");
      }
      if (parent && isStatementPosition(parent, node)) {
        addError(node, "Using declarations cannot appear in a single-statement context");
      }
      if (ts.isSourceFile(parent) && !ts.isExternalModule(parent)) {
        const isAwaitUsing = (node.declarationList.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
        addError(
          node,
          isAwaitUsing
            ? "'await using' declarations are not allowed at the top level of scripts"
            : "'using' declarations are not allowed at the top level of scripts",
        );
      }
      // ── 'using' binding restrictions ──────────────────────────────
      // ES spec: UsingDeclaration only allows BindingIdentifier, not patterns.
      // `using {} = x` and `using [] = x` are SyntaxErrors.
      // Each binding must also have an initializer (using is always IsConstantDeclaration).
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          addError(decl.name, "Using declarations require a binding identifier, not a destructuring pattern");
        } else if (!decl.initializer) {
          addError(decl, "Using declarations require an initializer");
        }
      }
    }

    // ── Fields named "constructor" in class ──────────────────────────
    // ES spec: ClassElement: FieldDefinition ;
    //   It is a Syntax Error if PropName of FieldDefinition is "constructor".
    // ES spec: ClassElement: static FieldDefinition ;
    //   It is a Syntax Error if PropName of FieldDefinition is "prototype" or "constructor".
    // So "constructor" is always forbidden as a field name (static or not).
    if (ts.isPropertyDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name === "constructor") {
        addError(node, "Classes may not have a field named 'constructor'");
      }
    }

    // ── Duplicate constructor methods ────────────────────────────────
    // ES spec: It is a Syntax Error if PrototypePropertyNameList of ClassElementList
    // contains more than one occurrence of "constructor".
    // Handled by checkDuplicateConstructors in the class-level check.

    // ── HTML single-line close comment in module ─────────────────────
    // ES spec: HTML-like comments (<!-- and -->) are only valid in scripts.
    // We're always in module mode. Check for --> at the start of a line.
    // Note: TS parser doesn't flag this.

    ts.forEachChild(node, visit);
  }

  /** Check if a node is inside a class static initializer block. */
  function isInsideClassStaticBlock(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isClassStaticBlockDeclaration(current)) return true;
      // ALL function boundaries stop the search, including arrow functions.
      // ES spec: ContainsAwait returns false for ArrowFunction, meaning
      // `await` as an identifier inside an arrow within a static block is valid.
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is inside any function (for return statement validation). */
  function isInsideFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if a node is inside any function (sync or async, including arrow, method, etc.)
   * Used to detect AwaitExpression in non-async function (a SyntaxError in module context).
   */
  function isInsideAnyFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Returns true if the node is inside a function that is itself inside another function
   * (i.e., the function depth is >= 2 from SourceFile).
   *
   * Used instead of isInsideAnyFunction for the await-in-non-async-function check because
   * the test262 runner wraps all module code in `export function test() { ... }`.
   * Top-level-await tests have `await` directly inside test() (depth 1) — these should
   * not be flagged. Negative tests like `function fn() { await 0; }` have `await` inside
   * fn() inside test() (depth 2) — these should be flagged.
   */
  function isInsideNestedFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    let depth = 0;
    while (current) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        depth++;
        if (depth >= 2) return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if an expression tree contains `arguments` identifier reference.
   * Used for ES spec ContainsArguments check in class field initializers.
   * Does NOT cross function boundaries (arguments is valid inside nested functions).
   */
  function containsArguments(node: ts.Node): boolean {
    if (ts.isIdentifier(node) && node.text === "arguments") {
      // Check it's not a property name
      const parent = node.parent;
      if (
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node))
      ) {
        return false;
      }
      return true;
    }
    // Don't cross function boundaries — arguments IS valid inside nested functions
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return false;
    }
    // Arrow functions don't bind arguments — keep searching
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsArguments(child)) {
        found = true;
      }
    });
    return found;
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
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
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
      if (
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return true;
      }
      // Class property declarations (field initializers) inherit super context
      // e.g. class C extends B { func = () => { super.prop; } }
      if (ts.isPropertyDeclaration(current) && ts.isClassDeclaration(current.parent)) {
        return true;
      }
      if (ts.isPropertyDeclaration(current) && ts.isClassExpression(current.parent)) {
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
    return (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    );
  }

  /** Check if `continue` is inside a valid iteration statement. Respects labels and function boundaries. */
  function isInsideIteration(node: ts.Node, label?: string): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      // Function and class static block boundaries stop the search
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isClassStaticBlockDeclaration(current)
      ) {
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
      // Function and class static block boundaries stop the search
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isClassStaticBlockDeclaration(current)
      ) {
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

  /**
   * Check for duplicate label names in a block (for class static block bodies).
   * ES spec: ContainsDuplicateLabels must be false.
   * Does not cross function boundaries.
   */
  function checkDuplicateLabelsInBlock(block: ts.Block): void {
    const labels = new Set<string>();
    function walkForLabels(node: ts.Node): void {
      // Don't cross function/class boundaries
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      ) {
        return;
      }
      if (ts.isLabeledStatement(node)) {
        const label = node.label.text;
        if (labels.has(label)) {
          addError(node.label, `Duplicate label '${label}' in class static block`);
        } else {
          labels.add(label);
          walkForLabels(node.statement);
          labels.delete(label);
        }
        return;
      }
      ts.forEachChild(node, walkForLabels);
    }
    ts.forEachChild(block, walkForLabels);
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
    const privateNames = new Map<string, { kinds: Set<string>; isStatic: boolean }>();
    for (const member of classNode.members) {
      if (member.name && ts.isPrivateIdentifier(member.name)) {
        const name = member.name.text;
        const memberIsStatic = ts.canHaveModifiers(member)
          ? (ts.getModifiers(member as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
          : false;
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
          privateNames.set(name, { kinds: new Set([kind]), isStatic: memberIsStatic });
        } else {
          // get+set pair is allowed ONLY if both have the same staticness
          const combined = new Set([...existing.kinds, kind]);
          if (
            combined.size === 2 &&
            combined.has("get") &&
            combined.has("set") &&
            existing.isStatic === memberIsStatic
          ) {
            // This is fine — getter+setter pair with same staticness
            existing.kinds.add(kind);
          } else {
            addError(member.name, `Duplicate private name '${name}'`);
          }
        }
      }
    }
  }

  /**
   * Check if a node is inside the formal parameters of a generator function.
   * ES spec: FormalParameters of generators use [+Yield] but YieldExpression
   * is forbidden — "It is a Syntax Error if FormalParameters Contains YieldExpression".
   */
  function isInsideGeneratorParams(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isParameter(current)) {
        const func = current.parent;
        if ((ts.isFunctionDeclaration(func) || ts.isFunctionExpression(func)) && func.asteriskToken) {
          return true;
        }
        if (ts.isMethodDeclaration(func) && func.asteriskToken) {
          return true;
        }
        return false;
      }
      // Stop at function boundaries
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if a node is inside the formal parameters of an async function.
   * ES spec: "It is a Syntax Error if FormalParameters Contains AwaitExpression".
   */
  function isInsideAsyncParams(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isParameter(current)) {
        const func = current.parent;
        if (
          (ts.isFunctionDeclaration(func) ||
            ts.isFunctionExpression(func) ||
            ts.isArrowFunction(func) ||
            ts.isMethodDeclaration(func)) &&
          func.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ) {
          return true;
        }
        return false;
      }
      // Stop at function boundaries
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is inside an async function (including async generators). */
  function isInsideAsyncFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      // Class static blocks create a new scope — stop searching
      if (ts.isClassStaticBlockDeclaration(current)) return false;
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
        return current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      }
      if (ts.isArrowFunction(current)) {
        return current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      }
      current = current.parent;
    }
    return false;
  }

  /** Check if a node is inside a generator function (including async generators). */
  function isInsideGeneratorFunction(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      // Class static blocks create a new scope — stop searching
      if (ts.isClassStaticBlockDeclaration(current)) return false;
      if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.asteriskToken) {
        return true;
      }
      if (ts.isMethodDeclaration(current) && current.asteriskToken) {
        return true;
      }
      // Arrow functions are never generators, but they don't create a new yield scope
      // If we hit an arrow, keep going up — arrows inherit the generator context
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current)) {
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
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
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

  /** Check for var/lexical declaration conflicts in a block or source file. */
  function checkVarLexicalConflicts(block: ts.Block | ts.SourceFile): void {
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
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    ts.forEachChild(node, (child) => collectVarDeclaredNamesInBlock(child, lexicalNames));
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
      errors.push({
        message: `Cannot access '${name}' before initialization`,
        line: p.line,
        column: p.column,
        severity: "warning",
      });
      return;
    }
    // Don't descend into nested function scopes -- they create their own TDZ
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
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
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === objLit
    ) {
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
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === arrLit
    )
      return true;
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === arrLit;
    if (ts.isArrayLiteralExpression(parent)) return isAssignmentPatternContext_expr(parent);
    if (ts.isPropertyAssignment(parent)) {
      const gp = parent.parent;
      if (ts.isObjectLiteralExpression(gp)) return isAssignmentPatternContext(gp);
    }
    return false;
  }

  /**
   * Validate an ArrayLiteralExpression used as an assignment pattern (LHS of =, for-of, for-in).
   * ES spec: ArrayAssignmentPattern restrictions:
   * - Rest element (...x) must be last — no elements may follow
   * - No trailing comma after rest (treated as elision after rest = error)
   * - Rest element may not have an initializer (= default) — e.g. [...x = 1] = []
   * - Each element must be a valid DestructuringAssignmentTarget
   * - Comma expressions (x, y) are not valid element targets
   * Strict mode: eval/arguments cannot appear as identifiers in assignment targets
   */
  function validateArrayAssignmentPattern(arr: ts.ArrayLiteralExpression, strict: boolean): void {
    let foundRest = false;
    let restNode: ts.Node | undefined;
    for (let i = 0; i < arr.elements.length; i++) {
      const elem = arr.elements[i];
      // Elision (omitted element, e.g. [, x]) — valid unless after rest
      if (elem.kind === ts.SyntaxKind.OmittedExpression) {
        if (foundRest) {
          addError(restNode ?? elem, "Rest element must be last in a destructuring pattern");
        }
        continue;
      }
      if (ts.isSpreadElement(elem)) {
        if (foundRest) {
          addError(elem, "Rest element must be last in a destructuring pattern");
        }
        foundRest = true;
        restNode = elem;
        // Rest element with initializer: [...x = 1] — not valid
        const restExpr = elem.expression;
        if (ts.isBinaryExpression(restExpr) && restExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          addError(elem, "Rest element may not have a default initializer");
        }
        // Validate the rest target itself
        validateAssignmentTarget(restExpr, strict);
      } else {
        if (foundRest) {
          addError(elem, "Rest element must be last in a destructuring pattern");
        }
        // Each element is an AssignmentElement: target (= default)?
        // Extract target and initializer
        let target: ts.Expression = elem;
        if (ts.isBinaryExpression(elem) && elem.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          target = elem.left;
          // Validate default value for yield/await issues if needed
        }
        validateAssignmentTarget(target, strict);
      }
    }
    // If there's a trailing comma after a rest, it creates an elision — already caught above.
    // But TS may also insert an OmittedExpression at the end for trailing commas.
    // The check above handles it via "elision after rest".
  }

  /**
   * Validate an ObjectLiteralExpression used as an assignment pattern.
   * ES spec: ObjectAssignmentPattern restrictions:
   * - Methods (shorthand methods, getters, setters) are not valid property values
   * - Each property value must be a valid assignment target
   * Strict mode: eval/arguments as shorthand names are errors
   */
  function validateObjectAssignmentPattern(obj: ts.ObjectLiteralExpression, strict: boolean): void {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        // Rest in object: { ...rest } = x — valid, but rest may not have computed
        validateAssignmentTarget(prop.expression, strict);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        // { x } = obj or { x = default } = obj
        if (strict) {
          const name = prop.name.text;
          if (name === "eval" || name === "arguments") {
            addError(prop.name, `Binding '${name}' in strict mode is not allowed`);
          }
        }
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        // { key: value } = obj
        validateAssignmentTarget(prop.initializer, strict);
        continue;
      }
      // Shorthand methods, getters, setters are always invalid in assignment patterns
      if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        addError(prop, "Method definitions are not allowed in assignment patterns");
      }
    }
  }

  /**
   * Validate a single assignment target in a destructuring position.
   * Flags: comma expressions, getter/setter as targets, invalid simple targets.
   */
  function validateAssignmentTarget(expr: ts.Expression, strict: boolean): void {
    // Unwrap parentheses
    let target: ts.Node = expr;
    while (ts.isParenthesizedExpression(target)) target = (target as ts.ParenthesizedExpression).expression;

    // Comma expression is never a valid assignment target
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      addError(expr, "Invalid destructuring assignment target");
      return;
    }
    // Nested array pattern
    if (ts.isArrayLiteralExpression(target)) {
      validateArrayAssignmentPattern(target, strict);
      return;
    }
    // Nested object pattern
    if (ts.isObjectLiteralExpression(target)) {
      validateObjectAssignmentPattern(target, strict);
      return;
    }
    // Binary assignment with default value: target = default
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      validateAssignmentTarget(target.left, strict);
      return;
    }
    // Simple targets: identifiers, property access, element access
    if (ts.isIdentifier(target)) {
      if (strict && (target.text === "eval" || target.text === "arguments")) {
        addError(target, `Invalid assignment target '${target.text}' in strict mode`);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      return;
    }
  }

  visit(sourceFile);

  // ── export default const/var/let — always SyntaxError ────────────
  // ES spec: ExportDeclaration : export default HoistableDeclaration |
  //          export default ClassDeclaration | export default [LAE] AssignmentExpression ;
  // VariableStatement and LexicalDeclaration are not valid after export default.
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // TS models `export default expr` as ExportAssignment.
      // But `export default const x = 1` is parsed differently — TS may parse it
      // as ExportAssignment with the expression being an error node.
      // Check the raw source for the pattern.
      const start = stmt.getStart(sourceFile);
      const rawText = sourceFile.text.substring(start, start + 30);
      if (/^export\s+default\s+(?:const|let|var)\b/.test(rawText)) {
        addError(stmt, "A default export may not be a variable/lexical declaration");
      }
    }
  }

  // ── Duplicate labels — always SyntaxError ──────────────────────────
  // ES spec: ContainsDuplicateLabels of StatementList must be false.
  // A label is duplicated if the same label name is nested (not sibling).
  function checkDuplicateLabels(node: ts.Node, activeLabels: Set<string>): void {
    // Don't cross function/class boundaries
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isLabeledStatement(node)) {
      const label = node.label.text;
      if (activeLabels.has(label)) {
        addError(node.label, `Duplicate label '${label}'`);
      } else {
        activeLabels.add(label);
        checkDuplicateLabels(node.statement, activeLabels);
        activeLabels.delete(label);
      }
      return;
    }
    ts.forEachChild(node, (child) => checkDuplicateLabels(child, activeLabels));
  }
  checkDuplicateLabels(sourceFile, new Set());

  // ── Duplicate export names (source-file level check) ──────────────
  // ES spec: It is a Syntax Error if ExportedNames contains any duplicate entries.
  const exportedNames = new Map<string, ts.Node>();
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const exportName = (spec.propertyName ?? spec.name).text;
          const exportedAs = spec.name.text;
          if (exportedNames.has(exportedAs)) {
            addError(spec, `Duplicate export name '${exportedAs}'`);
          } else {
            exportedNames.set(exportedAs, spec);
          }
        }
      }
      // export * as name — adds 'name' to exported names
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        const exportedAs = stmt.exportClause.name.text;
        if (exportedNames.has(exportedAs)) {
          addError(stmt.exportClause, `Duplicate export name '${exportedAs}'`);
        } else {
          exportedNames.set(exportedAs, stmt.exportClause);
        }
      }
    }
    if (ts.isExportAssignment(stmt)) {
      if (exportedNames.has("default")) {
        addError(stmt, "Duplicate export name 'default'");
      } else {
        exportedNames.set("default", stmt);
      }
    }
    // export function/class/variable declarations contribute to exported names
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : stmt.name.text;
      if (exportedNames.has(name)) {
        addError(stmt.name, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name);
      }
    }
    if (
      ts.isClassDeclaration(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const isDefault = ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const name = isDefault ? "default" : (stmt.name?.text ?? "default");
      if (exportedNames.has(name)) {
        addError(stmt.name ?? stmt, `Duplicate export name '${name}'`);
      } else {
        exportedNames.set(name, stmt.name ?? stmt);
      }
    }
    if (
      ts.isVariableStatement(stmt) &&
      ts.canHaveModifiers(stmt) &&
      ts.getModifiers(stmt as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          if (exportedNames.has(decl.name.text)) {
            addError(decl.name, `Duplicate export name '${decl.name.text}'`);
          } else {
            exportedNames.set(decl.name.text, decl.name);
          }
        }
      }
    }
  }

  // ── Import/Export declaration position (ES static semantics) ────
  // ImportDeclaration / ExportDeclaration / ExportAssignment (aka export
  // default) are ModuleItems — they may only appear at the top level of
  // a Module. TypeScript's parser reports diagnostic 1232 for nested
  // imports, which we tolerate elsewhere, so re-assert the rule here.
  // Rejects cases like `while (x) export default null;`, `try { } finally
  // { import v from "./x"; }`, or `(class { method() { export default 1; } })`.
  //
  // Skip when the source was wrapped by tests/test262-runner wrapTest — that
  // wrapper buries the original test body inside `export function test()`,
  // and any legitimately top-level `import`/`export` in the original source
  // ends up nested inside the wrapper. wrapTest is only used for positive
  // tests; negative parse tests go through buildNegativeCompileSource which
  // does not wrap.
  const isWrapTestSource = sourceFile.statements.some(
    (s) =>
      ts.isFunctionDeclaration(s) &&
      s.name?.text === "test" &&
      ts.canHaveModifiers(s) &&
      ts.getModifiers(s as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      s.type &&
      s.type.kind === ts.SyntaxKind.NumberKeyword,
  );
  if (!isWrapTestSource) {
    const checkModuleItemPosition = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportAssignment(node)
      ) {
        if (node.parent && !ts.isSourceFile(node.parent)) {
          const kind = ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ? "import" : "export";
          addError(node, `${kind} declarations may only appear at the top level of a module`);
          return;
        }
      }
      ts.forEachChild(node, checkModuleItemPosition);
    };
    checkModuleItemPosition(sourceFile);
  }

  // ── Reserved words: `yield` / `await` as identifier ─────────────
  // ES static semantics: `yield` is reserved in strict-mode code and
  // inside generator bodies; `await` is reserved in module code and
  // inside async function bodies. When these appear as IdentifierName
  // or BindingIdentifier in those contexts it is an early SyntaxError.
  //
  // TypeScript's parser accepts the raw identifiers without diagnostic,
  // so we catch them here. As with the module-item check, skip when
  // the wrapTest sentinel is present — wrapTest renames bare `yield` to
  // `_yield` outside generators, so wrapped positive tests will never
  // see these identifiers in the AST.
  if (!isWrapTestSource) {
    const sourceFileIsModule = ts.isExternalModule(sourceFile);
    const checkReservedIdentifiers = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && (node.text === "yield" || node.text === "await")) {
        // Skip cases where the identifier is a member / property name or
        // import / export name — those are IdentifierName positions and are
        // always allowed.
        const parent = node.parent;
        if (parent) {
          if (
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isQualifiedName(parent) && parent.right === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node) ||
            (ts.isImportSpecifier(parent) && parent.propertyName === node) ||
            (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
            (ts.isExportSpecifier(parent) && parent.name === node) ||
            (ts.isImportSpecifier(parent) && parent.name === node)
          ) {
            return; // property / import / export name position — allowed
          }
        }

        const name = node.text;
        if (name === "yield") {
          // Reserved in strict mode or inside any enclosing generator.
          let reserved = isStrictMode(node) || sourceFileIsModule;
          if (!reserved) {
            let c: ts.Node | undefined = node.parent;
            while (c) {
              if (
                (ts.isFunctionDeclaration(c) || ts.isFunctionExpression(c) || ts.isMethodDeclaration(c)) &&
                c.asteriskToken
              ) {
                reserved = true;
                break;
              }
              c = c.parent;
            }
          }
          if (reserved) {
            addError(node, "'yield' is a reserved word and may not be used as an identifier in strict mode");
          }
        } else if (name === "await") {
          // Reserved in module code and inside any enclosing async function.
          let reserved = sourceFileIsModule;
          if (!reserved) {
            let c: ts.Node | undefined = node.parent;
            while (c) {
              if (
                (ts.isFunctionDeclaration(c) ||
                  ts.isFunctionExpression(c) ||
                  ts.isArrowFunction(c) ||
                  ts.isMethodDeclaration(c)) &&
                c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
              ) {
                reserved = true;
                break;
              }
              c = c.parent;
            }
          }
          if (reserved) {
            addError(
              node,
              "'await' is a reserved word and may not be used as an identifier in module code or async functions",
            );
          }
        }
      }
      ts.forEachChild(node, checkReservedIdentifiers);
    };
    checkReservedIdentifiers(sourceFile);
  }

  // ── HTML close comment (-->) in module code ──────────────────────
  // HTML-like comments are allowed in scripts but not in modules.
  // Check the raw source so we still catch cases TS tokenizes permissively.
  if (ts.isExternalModule(sourceFile)) {
    for (const line of sourceFile.text.split(/\r?\n/u)) {
      if (/^\s*(?:;+\s*)?-->/.test(line)) {
        const offset = sourceFile.text.indexOf(line);
        const lineNode = findInnermostNodeAtPosition(sourceFile, offset);
        addError(lineNode, "HTML close comments are not allowed in module code");
        break;
      }
    }
  }

  // ── Duplicate class constructors ──────────────────────────────────
  // ES spec: It is a Syntax Error if PrototypePropertyNameList of ClassElementList
  // contains more than one occurrence of "constructor".
  function checkDuplicateConstructors(classNode: ts.ClassDeclaration | ts.ClassExpression) {
    let ctorCount = 0;
    for (const member of classNode.members) {
      if (ts.isConstructorDeclaration(member)) {
        // Only count constructors with a body (declarations without bodies are overloads)
        if (member.body) {
          ctorCount++;
          if (ctorCount > 1) {
            addError(member, "A class may only have one constructor");
            break;
          }
        }
      }
    }
  }
  // Walk all classes to check for duplicate constructors
  function checkClassesForDuplicateCtors(node: ts.Node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      checkDuplicateConstructors(node);
    }
    ts.forEachChild(node, checkClassesForDuplicateCtors);
  }
  checkClassesForDuplicateCtors(sourceFile);

  return errors;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Hardened mode: walk AST and reject dangerous patterns.
 * Inspired by Endo/SES — compile-time rejection of insecure features.
 */
function validateHardenedMode(
  sourceFile: ts.SourceFile,
): Array<{ message: string; line: number; column: number; severity: "error" }> {
  const errors: Array<{ message: string; line: number; column: number; severity: "error" }> = [];

  function visit(node: ts.Node): void {
    // Reject eval() calls
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] eval() is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject new Function()
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] new Function() is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject with statements
    if (ts.isWithStatement(node)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      errors.push({
        message: "[hardened] with statement is not allowed",
        line: line + 1,
        column: character,
        severity: "error",
      });
    }
    // Reject __proto__ assignment
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "__proto__") {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        errors.push({
          message: "[hardened] __proto__ assignment is not allowed",
          line: line + 1,
          column: character,
          severity: "error",
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

/**
 * ES spec: PerformEval runs early-error checks on the eval'd source.
 * `super()` is a SyntaxError unless the eval is a *direct* eval in a
 * context where a SuperCall is allowed (i.e. inside a derived class
 * constructor body). Indirect eval (`(0, eval)(...)`, `var e = eval; e(...)`)
 * always rejects super(), as does direct eval outside the constructor
 * (e.g. inside a class field initializer).
 *
 * Since #1054, if we see an `eval(<literal>)` or `(0, eval)(<literal>)`
 * whose literal contains `super(`, we rewrite the call to a throwing IIFE
 * so the SyntaxError fires at runtime when the surrounding expression runs
 * (e.g. when a field initializer is evaluated during `new C()`).
 *
 * Narrowing:
 * - Only string-literal arg is examined (single/double quoted). Template
 *   literals are not test262-tested in this pattern.
 * - Only `super(` in the string triggers rewrite — `super.x` / `super[x]`
 *   are legal in eval-from-field-initializer and must not be rewritten.
 * - Direct eval from a derived constructor would legitimately allow
 *   super(), but test262 has no passing tests covering that pattern.
 */
function rewriteEvalSuperCall(source: string): string {
  const hasSuperCall = (s: string) => /\bsuper\s*\(/.test(s);
  const replacement = `((function(){throw new SyntaxError("super() not allowed in eval (early error)")}()))`;

  const sqBody = `(?:[^'\\\\\\n]|\\\\.)*?`;
  const dqBody = `(?:[^"\\\\\\n]|\\\\.)*?`;
  const indirectSq = new RegExp(`\\(\\s*0\\s*,\\s*eval\\s*\\)\\s*\\(\\s*'(${sqBody})'\\s*\\)`, "g");
  const indirectDq = new RegExp(`\\(\\s*0\\s*,\\s*eval\\s*\\)\\s*\\(\\s*"(${dqBody})"\\s*\\)`, "g");
  const directSq = new RegExp(`(^|[^\\w$.])eval\\s*\\(\\s*'(${sqBody})'\\s*\\)`, "g");
  const directDq = new RegExp(`(^|[^\\w$.])eval\\s*\\(\\s*"(${dqBody})"\\s*\\)`, "g");

  let out = source;
  out = out.replace(indirectSq, (full, body) => (hasSuperCall(body) ? replacement : full));
  out = out.replace(indirectDq, (full, body) => (hasSuperCall(body) ? replacement : full));
  out = out.replace(directSq, (full, prefix, body) => (hasSuperCall(body) ? `${prefix}${replacement}` : full));
  out = out.replace(directDq, (full, prefix, body) => (hasSuperCall(body) ? `${prefix}${replacement}` : full));
  return out;
}

export {
  DEFAULT_BLOCKED_MEMBERS,
  detectEarlyErrors,
  getApproxSourceLocation,
  hasExportModifier,
  pushSourceAnchoredDiagnostic,
  rewriteEvalSuperCall,
  validateHardenedMode,
  validateSafeMode,
};
