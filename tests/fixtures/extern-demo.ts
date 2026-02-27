declare namespace Host {
  class Box {
    constructor();
    width: number;
    height: number;
    label: string;
  }
  class Renderer {
    constructor(canvas: any);
    render(box: Box): void;
    clear(): void;
  }
}

export function makeBox(): Host.Box {
  const b = new Host.Box();
  b.width = 10;
  b.height = 20;
  b.label = "hello";
  return b;
}

export function area(box: Host.Box): number {
  return box.width * box.height;
}

export function greet(name: string): string {
  return "Hello, " + name + "!";
}
