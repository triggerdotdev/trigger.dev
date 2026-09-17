import { parseEnvironmentVariableForm } from "~/v3/environmentVariables/forms";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  EditEnvironmentVariableValue,
  EnvironmentVariableValue,
} from "~/v3/environmentVariables/repository";

describe("Environment variable edit form", () => {
  test("accepts an empty value", () => {
    const formData = new FormData();
    formData.set("id", "var_123");
    formData.set("environmentId", "env_123");
    formData.set("value", "");

    const submission = parseEnvironmentVariableForm(formData, EditEnvironmentVariableValue);

    expect(submission.status).toBe("success");
    if (submission.status === "success") {
      expect(submission.value.value).toBe("");
    }
  });

  test("accepts a non-empty value", () => {
    const formData = new FormData();
    formData.set("id", "var_123");
    formData.set("environmentId", "env_123");
    formData.set("value", "hello");

    const submission = parseEnvironmentVariableForm(formData, EditEnvironmentVariableValue);

    expect(submission.status).toBe("success");
    if (submission.status === "success") {
      expect(submission.value.value).toBe("hello");
    }
  });
});

describe("EnvironmentVariableValue field (shared by create and edit forms)", () => {
  test("preserves an empty value through conform coercion", () => {
    const formData = new FormData();
    formData.set("value", "");

    const submission = parseEnvironmentVariableForm(
      formData,
      z.object({ value: EnvironmentVariableValue })
    );

    expect(submission.status).toBe("success");
    if (submission.status === "success") {
      expect(submission.value.value).toBe("");
    }
  });
});

test("missing values are rejected, including nested create rows", () => {
  const edit = new FormData();
  edit.set("id", "var_123");
  edit.set("environmentId", "env_123");
  expect(parseEnvironmentVariableForm(edit, EditEnvironmentVariableValue).status).toBe("error");
  const schema = z.object({
    variables: z.array(z.object({ key: z.string(), value: EnvironmentVariableValue })),
  });
  const create = new FormData();
  create.set("variables[0].key", "EMPTY");
  expect(parseEnvironmentVariableForm(create, schema).status).toBe("error");
  create.set("variables[0].value", "");
  const result = parseEnvironmentVariableForm(create, schema);
  expect(result.status).toBe("success");
  if (result.status === "success")
    expect(result.value.variables).toEqual([{ key: "EMPTY", value: "" }]);
});

test("preserves the explicit empty-secret choice for the write handler", () => {
  const form = new FormData();
  form.set("id", "var_123");
  form.set("environmentId", "env_123");
  // The disabled text input is replaced by a hidden empty value field.
  form.set("value", "");
  form.set("setEmptyValue", "true");
  const result = parseEnvironmentVariableForm(form, EditEnvironmentVariableValue);
  expect(result.status).toBe("success");
  if (result.status === "success") {
    expect(result.value.value).toBe("");
    expect(result.value.setEmptyValue).toBe("true");
  }
});

test("preserves whitespace when empty is not selected", () => {
  const form = new FormData();
  form.set("id", "var_123");
  form.set("environmentId", "env_123");
  form.set("value", "   ");
  const result = parseEnvironmentVariableForm(form, EditEnvironmentVariableValue);
  expect(result.status).toBe("success");
  if (result.status === "success") expect(result.value.value).toBe("   ");
});

test("disabled rollout rejects empty form values while enabled accepts them", () => {
  const form = new FormData();
  form.set("id", "var_123");
  form.set("environmentId", "env_123");
  form.set("value", "");
  expect(parseEnvironmentVariableForm(form, EditEnvironmentVariableValue, false).status).toBe(
    "error"
  );
  expect(parseEnvironmentVariableForm(form, EditEnvironmentVariableValue, true).status).toBe(
    "success"
  );
});
