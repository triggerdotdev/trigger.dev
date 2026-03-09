import { flattenAttributes, unflattenAttributes } from "./packages/core/src/v3/utils/flattenAttributes";

const cases = [
    {
        name: "Key with period",
        obj: { "Key 0.002mm": 31.4 },
    },
    {
        name: "Nested key with period",
        obj: { parent: { "child.key": "value" } },
    },
    {
        name: "Regular nested key",
        obj: { parent: { child: "value" } },
    },
    {
        name: "Array with period in key",
        obj: { "list.0": ["item1"] },
    },
    {
        name: "Complex mixed",
        obj: {
            "a.b": {
                "c.d": "value",
                e: [1, 2]
            }
        }
    }
];

let allPassed = true;

for (const { name, obj } of cases) {
    const flattened = flattenAttributes(obj);
    const unflattened = unflattenAttributes(flattened);
    const success = JSON.stringify(unflattened) === JSON.stringify(obj);

    console.log(`Case: ${name}`);
    console.log("  Flattened:", JSON.stringify(flattened));
    console.log("  Unflattened:", JSON.stringify(unflattened));
    console.log("  Result:", success ? "SUCCESS" : "FAILURE");

    if (!success) allPassed = false;
}

if (allPassed) {
    console.log("\nALL TESTS PASSED!");
} else {
    console.log("\nSOME TESTS FAILED!");
    process.exit(1);
}
