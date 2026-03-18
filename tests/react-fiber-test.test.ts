import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("React fiber tree (self-referencing structs)", () => {
  const fiberClass = `
    class FiberNode {
      tag: number;
      type_: number;
      child: FiberNode | null = null;
      sibling: FiberNode | null = null;
      return_: FiberNode | null = null;
      pendingProps: number = 0;
      memoizedProps: number = 0;
      flags: number = 0;
      constructor(tag: number, type_: number) {
        this.tag = tag;
        this.type_ = type_;
      }
    }
  `;

  it("creates a fiber node and reads properties", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const node = new FiberNode(1, 42);
          return node.tag + node.type_;
        }`,
        "test",
      ),
    ).toBe(43);
  });

  it("links parent and child (self-referencing assignment)", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const root = new FiberNode(0, 1);
          const child = new FiberNode(1, 2);
          root.child = child;
          child.return_ = root;
          return root.child.type_ + child.return_.type_;
        }`,
        "test",
      ),
    ).toBe(3); // child.type_(2) + root.type_(1)
  });

  it("builds a 3-node fiber tree (root -> child1 -> child2 via sibling)", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const root = new FiberNode(0, 10);
          const child1 = new FiberNode(1, 20);
          const child2 = new FiberNode(1, 30);

          root.child = child1;
          child1.return_ = root;
          child1.sibling = child2;
          child2.return_ = root;

          // Traverse: root -> child -> sibling
          let sum = root.type_;
          let current: FiberNode | null = root.child;
          while (current !== null) {
            sum = sum + current.type_;
            current = current.sibling;
          }
          return sum;
        }`,
        "test",
      ),
    ).toBe(60); // 10 + 20 + 30
  });

  it("null narrowing: checks child is null before access", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const node = new FiberNode(1, 5);
          if (node.child !== null) {
            return node.child.type_;
          }
          return -1;
        }`,
        "test",
      ),
    ).toBe(-1);
  });

  it("bitwise flag operations (placement, update, deletion)", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const node = new FiberNode(1, 0);
          const Placement = 2;
          const Update = 4;
          const Deletion = 8;

          // Set placement and update flags
          node.flags = node.flags | Placement;
          node.flags = node.flags | Update;

          // Check flags are set: Placement|Update = 6
          const beforeClear = node.flags;

          // Clear placement flag
          node.flags = node.flags & ~Placement;

          // Should have only Update (4)
          const afterClear = node.flags;

          // Set deletion
          node.flags = node.flags | Deletion;

          // Should have Update|Deletion = 12
          const final_ = node.flags;

          return beforeClear * 100 + afterClear * 10 + final_;
        }`,
        "test",
      ),
    ).toBe(6 * 100 + 4 * 10 + 12); // 652
  });

  it("linked list traversal counting nodes", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          // Build a sibling chain: n1 -> n2 -> n3 -> n4
          const n1 = new FiberNode(1, 0);
          const n2 = new FiberNode(1, 0);
          const n3 = new FiberNode(1, 0);
          const n4 = new FiberNode(1, 0);
          n1.sibling = n2;
          n2.sibling = n3;
          n3.sibling = n4;

          let count = 0;
          let current: FiberNode | null = n1;
          while (current !== null) {
            count = count + 1;
            current = current.sibling;
          }
          return count;
        }`,
        "test",
      ),
    ).toBe(4);
  });

  it("simple reconciliation: diff pendingProps vs memoizedProps", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          // Simulate reconciliation: compare pending vs memoized props
          const root = new FiberNode(0, 1);
          const child1 = new FiberNode(1, 2);
          const child2 = new FiberNode(1, 3);

          root.child = child1;
          child1.sibling = child2;
          child1.return_ = root;
          child2.return_ = root;

          // Set props: child1 unchanged, child2 changed
          child1.pendingProps = 100;
          child1.memoizedProps = 100;
          child2.pendingProps = 200;
          child2.memoizedProps = 150;

          // Walk children and count how many need update
          const Update = 4;
          let needsWork = 0;
          let fiber: FiberNode | null = root.child;
          while (fiber !== null) {
            if (fiber.pendingProps !== fiber.memoizedProps) {
              fiber.flags = fiber.flags | Update;
              needsWork = needsWork + 1;
            }
            // "Commit": copy pending to memoized
            fiber.memoizedProps = fiber.pendingProps;
            fiber = fiber.sibling;
          }

          // Verify: child2 should have Update flag, child1 should not
          const child1Flagged = (child1.flags & Update) !== 0 ? 1 : 0;
          const child2Flagged = (child2.flags & Update) !== 0 ? 1 : 0;

          // Return: needsWork * 100 + child1Flagged * 10 + child2Flagged
          return needsWork * 100 + child1Flagged * 10 + child2Flagged;
        }`,
        "test",
      ),
    ).toBe(101); // 1 needs work, child1 not flagged, child2 flagged
  });

  it("return_ traversal: walk up from leaf to root", async () => {
    expect(
      await run(
        `${fiberClass}
        export function test(): number {
          const root = new FiberNode(0, 1);
          const mid = new FiberNode(1, 2);
          const leaf = new FiberNode(2, 3);

          root.child = mid;
          mid.return_ = root;
          mid.child = leaf;
          leaf.return_ = mid;

          // Walk up from leaf to root, summing tags
          let sum = 0;
          let current: FiberNode | null = leaf;
          while (current !== null) {
            sum = sum + current.tag;
            current = current.return_;
          }
          return sum;
        }`,
        "test",
      ),
    ).toBe(3); // 2 + 1 + 0
  });
});
