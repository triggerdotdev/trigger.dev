import { EventFilter } from "../src";
import { eventFilterMatches } from "../src/eventFilterMatches";

describe("eventFilterMatches", () => {
  it("should return true when payload matches string filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: ["John"],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches boolean filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      isAdmin: [false],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches number filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      age: [30],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches $startsWith content filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $startsWith: "Jo" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches $endsWith content filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $endsWith: "hn" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches $startsWith and $endsWith content filters", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $startsWith: "Jo" }, { $endsWith: "hn" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload does not match $anythingBut filter", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $anythingBut: "Jane" }],
      address: {
        street: [{ $anythingBut: "456 Elm St" }],
      },
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload does not match $anythingBut filter with an array", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $anythingBut: ["Jane", "Joe"] }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload does have a key that $exists = true", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $exists: true }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload does NOT have a key that $exists = false", () => {
    const payload = {
      name: "John",
      age: 30,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      foo: [{ $exists: false }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload does match numeric condition", () => {
    const payload = {
      name: "John",
      age: 30,
      score: 100,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      age: [{ $gt: 20 }, { $lt: 40 }],
      score: [{ $between: [90, 110] }],
    };

    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches an includes condition", () => {
    const payload = {
      name: "John",
      age: 30,
      score: 100,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      hobbies: [{ $includes: "reading" }],
    };

    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches an ignoreCaseEquals condition", () => {
    const payload = {
      name: "John",
      age: 30,
      score: 100,
      isAdmin: false,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      name: [{ $ignoreCaseEquals: "john" }],
    };

    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches an isNull condition", () => {
    const payload = {
      name: "John",
      age: 30,
      score: 100,
      isAdmin: false,
      confirmedAt: null,
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      confirmedAt: [{ $isNull: true }],
    };

    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return true when payload matches an isNull condition (flipped)", () => {
    const payload = {
      name: "John",
      age: 30,
      score: 100,
      isAdmin: false,
      confirmedAt: "2020-01-01T00:00:00.000Z",
      hobbies: ["reading", "swimming"],
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },
    };
    const filter: EventFilter = {
      confirmedAt: [{ $isNull: false }],
    };

    expect(eventFilterMatches(payload, filter)).toBe(true);
  });

  it("should return false when payload does not match string filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: ["John"],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not match string filter because it's the wrong type", () => {
    const payload = {
      name: "Jane",
      age: 25,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      age: ["John"],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not match boolean filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      isAdmin: [false],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not match number filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      age: [30],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not match $startsWith content filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: [{ $startsWith: "Jo" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not match $endsWith content filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: [{ $startsWith: "Ja" }, { $endsWith: "hn" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does match $anythingBut content filters", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: [{ $anythingBut: "Jane" }],
      address: {
        street: [{ $anythingBut: "456 Elm St" }],
      },
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does match $anythingBut content filters with an array", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: [{ $anythingBut: ["Jane", "John"] }],
      address: {
        street: [{ $anythingBut: "456 Elm St" }],
      },
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does not have a key that $exists = true", () => {
    const payload = {
      name: "Jane",
      age: 25,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      foo: [{ $exists: true }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when payload does have a key that $exists = false", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
    };
    const filter: EventFilter = {
      name: [{ $exists: false }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when the payload does not match the numeric filters", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
        latitude: 37.7749,
        longitude: 122.4194,
      },
    };
    const filter: EventFilter = {
      age: [{ $gt: 30 }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("Should return false when the payload does not match an includes filter", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "San Francisco",
        state: "CA",
        zip: "67890",
        latitude: 37.7749,
        longitude: 122.4194,
      },
    };
    const filter: EventFilter = {
      hobbies: [{ $includes: "swimming" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("Should return false when the payload does not match any ignoreCaseEquals condition", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      address: {
        street: "456 Elm St",
        city: "San Francisco",
        state: "CA",
        zip: "67890",
        latitude: 37.7749,
        longitude: 122.4194,
      },
    };
    const filter: EventFilter = {
      name: [{ $ignoreCaseEquals: "john" }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when the payload does not match an isNull condition", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      confirmedAt: "2020-01-01T00:00:00.000Z",
      address: {
        street: "456 Elm St",
        city: "San Francisco",
        state: "CA",
        zip: "67890",
        latitude: 37.7749,
        longitude: 122.4194,
      },
    };
    const filter: EventFilter = {
      confirmedAt: [{ $isNull: true }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });

  it("should return false when the payload does not match an isNull condition (flipped)", () => {
    const payload = {
      name: "Jane",
      age: 25,
      score: 100,
      isAdmin: true,
      hobbies: ["running", "yoga"],
      confirmedAt: null,
      address: {
        street: "456 Elm St",
        city: "San Francisco",
        state: "CA",
        zip: "67890",
        latitude: 37.7749,
        longitude: 122.4194,
      },
    };
    const filter: EventFilter = {
      confirmedAt: [{ $isNull: false }],
    };
    expect(eventFilterMatches(payload, filter)).toBe(false);
  });
});
