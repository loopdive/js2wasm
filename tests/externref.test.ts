import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("externref host imports", () => {
  it("extern class constructor returns externref", async () => {
    const result = compile(`
      declare namespace Host {
        class Widget {
          constructor(x: number);
        }
      }
      export function makeWidget(x: number): Host.Widget {
        return new Host.Widget(x);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
    expect(result.wat).toContain("externref");

    const constructed: number[] = [];
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Host_Widget_new: (x: number) => {
          constructed.push(x);
          return { __widget: true };
        },
      },
    });
    const exports = instance.exports as any;
    const widget = exports.makeWidget(42);
    expect(constructed).toEqual([42]);
    expect(widget).toBeDefined();
  });

  it("method call on externref object", async () => {
    const result = compile(`
      declare namespace Host {
        class Counter {
          constructor();
          increment(): void;
          getValue(): number;
        }
      }
      export function test(): number {
        const c = new Host.Counter();
        c.increment();
        c.increment();
        return c.getValue();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    let count = 0;
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Host_Counter_new: () => ({}),
        Host_Counter_increment: () => {
          count++;
        },
        Host_Counter_getValue: () => count,
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(2);
  });

  it("property set on externref", async () => {
    const result = compile(`
      declare namespace Host {
        class Box {
          constructor();
          left: number;
          right: number;
        }
      }
      export function setProps(box: Host.Box, l: number, r: number): void {
        box.left = l;
        box.right = r;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const setValues: Record<string, number> = {};
    const mockBox = {};
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Host_Box_new: () => mockBox,
        Host_Box_get_left: () => 0,
        Host_Box_set_left: (_obj: any, v: number) => {
          setValues.left = v;
        },
        Host_Box_get_right: () => 0,
        Host_Box_set_right: (_obj: any, v: number) => {
          setValues.right = v;
        },
      },
    });
    const exports = instance.exports as any;
    exports.setProps(mockBox, 10, 20);
    expect(setValues).toEqual({ left: 10, right: 20 });
  });

  it("property get on externref", async () => {
    const result = compile(`
      declare namespace Host {
        class Box {
          constructor();
          width: number;
          height: number;
        }
      }
      export function area(box: Host.Box): number {
        return box.width * box.height;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const mockBox = {};
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Host_Box_new: () => mockBox,
        Host_Box_get_width: () => 5,
        Host_Box_set_width: () => {},
        Host_Box_get_height: () => 3,
        Host_Box_set_height: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.area(mockBox)).toBe(15);
  });

  it("chained property access + method call", async () => {
    const result = compile(`
      declare namespace Host {
        class Vec3 {
          constructor();
          set(x: number, y: number, z: number): void;
        }
        class Camera {
          constructor();
          position: Vec3;
        }
      }
      export function setup(): void {
        const cam = new Host.Camera();
        cam.position.set(1, 2, 3);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const calls: any[] = [];
    const mockVec3 = { __type: "vec3" };
    const mockCam = { __type: "cam" };
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        Host_Vec3_new: () => mockVec3,
        Host_Vec3_set: (obj: any, x: number, y: number, z: number) => {
          calls.push({ obj, x, y, z });
        },
        Host_Camera_new: () => mockCam,
        Host_Camera_get_position: () => mockVec3,
        Host_Camera_set_position: () => {},
      },
    });
    const exports = instance.exports as any;
    exports.setup();
    expect(calls).toEqual([{ obj: mockVec3, x: 1, y: 2, z: 3 }]);
  });
});
