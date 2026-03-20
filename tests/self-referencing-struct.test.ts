import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("self-referencing struct types", () => {
  it("linked list: class with field of its own type", async () => {
    await assertEquivalent(
      `
      class ListNode {
        value: number;
        next: ListNode | null;
        constructor(value: number) {
          this.value = value;
          this.next = null;
        }
      }
      export function test(): number {
        const a = new ListNode(1);
        const b = new ListNode(2);
        const c = new ListNode(3);
        a.next = b;
        b.next = c;
        let sum = 0;
        let current: ListNode | null = a;
        while (current !== null) {
          sum += current.value;
          current = current.next;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("tree node: multiple self-referencing fields", async () => {
    await assertEquivalent(
      `
      class TreeNode {
        value: number;
        left: TreeNode | null;
        right: TreeNode | null;
        constructor(value: number) {
          this.value = value;
          this.left = null;
          this.right = null;
        }
      }
      export function test(): number {
        const root = new TreeNode(1);
        root.left = new TreeNode(2);
        root.right = new TreeNode(3);
        root.left.left = new TreeNode(4);
        return root.value + root.left.value + root.right.value + root.left.left.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("fiber-like pattern: child/sibling/return pointers", async () => {
    await assertEquivalent(
      `
      class Fiber {
        child: Fiber | null = null;
        sibling: Fiber | null = null;
        ret: Fiber | null = null;
        tag: number = 0;
      }
      export function test(): number {
        const parent = new Fiber();
        parent.tag = 1;
        const child1 = new Fiber();
        child1.tag = 2;
        const child2 = new Fiber();
        child2.tag = 3;
        parent.child = child1;
        child1.sibling = child2;
        child1.ret = parent;
        child2.ret = parent;
        return parent.tag + parent.child.tag + parent.child.sibling!.tag + child1.ret!.tag;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property declaration with self-referencing type", async () => {
    await assertEquivalent(
      `
      class Node {
        value: number = 0;
        next: Node | null = null;
      }
      export function test(): number {
        const a = new Node();
        a.value = 10;
        const b = new Node();
        b.value = 20;
        a.next = b;
        return a.next.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
