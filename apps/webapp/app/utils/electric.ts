import { Shape, ShapeStream, ShapeStreamOptions, Row } from "@electric-sql/client";
import { useMemo } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector.js";

const streamCache = new Map<string, ShapeStream>();
const shapeCache = new Map<ShapeStream, Shape>();

export async function preloadShape<T extends Row = Row>(
  options: ShapeStreamOptions
): Promise<Shape<T>> {
  const shapeStream = getShapeStream<T>(options);
  const shape = getShape<T>(shapeStream);
  await shape.value;
  return shape;
}

export function sortedOptionsHash(options: ShapeStreamOptions): string {
  return JSON.stringify(options, Object.keys(options).sort());
}

export function getShapeStream<T extends Row = Row>(options: ShapeStreamOptions): ShapeStream<T> {
  const shapeHash = sortedOptionsHash(options);

  // If the stream is already cached, return
  if (streamCache.has(shapeHash)) {
    // Return the ShapeStream
    return streamCache.get(shapeHash)! as ShapeStream<T>;
  } else {
    const newShapeStream = new ShapeStream<T>(options);

    streamCache.set(shapeHash, newShapeStream);

    // Return the created shape
    return newShapeStream;
  }
}

export function getShape<T extends Row>(shapeStream: ShapeStream<T>): Shape<T> {
  // If the stream is already cached, return
  if (shapeCache.has(shapeStream)) {
    // Return the ShapeStream
    return shapeCache.get(shapeStream)! as Shape<T>;
  } else {
    const newShape = new Shape<T>(shapeStream);

    shapeCache.set(shapeStream, newShape);

    // Return the created shape
    return newShape;
  }
}

export interface UseShapeResult<T extends Row = Row> {
  /**
   * The array of rows that make up the Shape.
   * @type {T[]}
   */
  data: T[];
  /**
   * The Shape instance used by this useShape
   * @type {Shape<T>}
   */
  shape: Shape<T>;
  error: Shape<T>[`error`];
  isError: boolean;
}

function shapeSubscribe<T extends Row>(shape: Shape<T>, callback: () => void) {
  const unsubscribe = shape.subscribe(callback);
  return () => {
    unsubscribe();
  };
}

function parseShapeData<T extends Row>(shape: Shape<T>): UseShapeResult<T> {
  return {
    data: [...shape.valueSync.values()],
    isError: shape.error !== false,
    shape,
    error: shape.error,
  };
}

function identity<T>(arg: T): T {
  return arg;
}

interface UseShapeOptions<SourceData extends Row, Selection> extends ShapeStreamOptions {
  selector?: (value: UseShapeResult<SourceData>) => Selection;
}

export function useShape<SourceData extends Row = Row, Selection = UseShapeResult<SourceData>>({
  selector = identity as (arg: UseShapeResult<SourceData>) => Selection,
  ...options
}: UseShapeOptions<SourceData, Selection>): Selection {
  const shapeStream = getShapeStream<SourceData>(options as ShapeStreamOptions);
  const shape = getShape<SourceData>(shapeStream);

  const useShapeData = useMemo(() => {
    let latestShapeData = parseShapeData(shape);
    const getSnapshot = () => latestShapeData;
    const subscribe = (onStoreChange: () => void) =>
      shapeSubscribe(shape, () => {
        latestShapeData = parseShapeData(shape);
        onStoreChange();
      });

    return () => {
      return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, selector);
    };
  }, [shape, selector]);

  return useShapeData();
}
