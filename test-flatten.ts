import { flattenAttributes, unflattenAttributes } from "./packages/core/src/v3/utils/flattenAttributes";

const obj1 = {
    "my.key.with.periods": "value1",
    nested: {
        "another.key": "value2"
    }
};

const flat = flattenAttributes(obj1);
console.log("Flattened:", flat);

const unflat = unflattenAttributes(flat);
console.log("Unflattened:", unflat);
