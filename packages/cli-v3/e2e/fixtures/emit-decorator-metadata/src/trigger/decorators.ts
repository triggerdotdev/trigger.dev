import "reflect-metadata";
import { task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "node:timers/promises";

class Point {
  constructor(
    public x: number,
    public y: number
  ) {}
}

class Line {
  private _start: Point;
  private _end: Point;

  @validate
  set start(value: Point) {
    this._start = value;
  }

  get start() {
    return this._start;
  }

  @validate
  set end(value: Point) {
    this._end = value;
  }

  get end() {
    return this._end;
  }
}

function validate<T>(target: any, propertyKey: string, descriptor: TypedPropertyDescriptor<T>) {
  let set = descriptor.set!;

  descriptor.set = function (value: T) {
    let type = Reflect.getMetadata("design:type", target, propertyKey);

    if (!(value instanceof type)) {
      throw new TypeError(`Invalid type, got ${typeof value} not ${type.name}.`);
    }

    set.call(this, value);
  };
}

export const decoratorsTask = task({
  id: "decoratorsTask",
  run: async () => {
    const line = new Line();
    line.start = new Point(0, 0);

    console.log("Hello, World!", { line });
  },
});
