import { schemaTask } from "@trigger.dev/sdk/v3";
import * as yup from "yup";

// Test Yup schema conversion
const contactSchema = yup.object({
  firstName: yup.string().required().min(2).max(50),
  lastName: yup.string().required().min(2).max(50),
  email: yup.string().email().required(),
  phone: yup.string().matches(/^[\d\s\-\+\(\)]+$/, "Invalid phone number").optional(),
  age: yup.number().positive().integer().min(18).max(120),
  preferences: yup.object({
    contactMethod: yup.string().oneOf(["email", "phone", "sms"]).default("email"),
    newsletter: yup.boolean().default(false),
    language: yup.string().oneOf(["en", "es", "fr", "de"]).default("en"),
  }).default({}),
  address: yup.object({
    street: yup.string().required(),
    city: yup.string().required(),
    state: yup.string().length(2).required(),
    zip: yup.string().matches(/^\d{5}$/).required(),
  }).optional(),
  tags: yup.array().of(yup.string()).min(1).max(10),
});

export const yupSchemaTask = schemaTask({
  id: "yup-schema-task",
  schema: contactSchema,
  run: async (payload, { ctx }) => {
    // Type checking: payload should be inferred from Yup schema
    const fullName = `${payload.firstName} ${payload.lastName}`;
    const email: string = payload.email;
    const phone: string | undefined = payload.phone;
    const age: number = payload.age;
    
    // Nested properties
    const contactMethod = payload.preferences.contactMethod;
    const newsletter: boolean = payload.preferences.newsletter;
    
    // Optional nested object
    const hasAddress = !!payload.address;
    const city = payload.address?.city;
    
    // Array
    const tagCount = payload.tags?.length ?? 0;

    return {
      contactId: `contact_${ctx.run.id}`,
      fullName,
      email,
      hasPhone: !!phone,
      hasAddress,
      tagCount,
      preferredContact: contactMethod,
    };
  },
});

// Test complex Yup validation with conditional logic
const orderValidationSchema = yup.object({
  orderType: yup.string().oneOf(["standard", "express", "same-day"]).required(),
  items: yup.array().of(
    yup.object({
      sku: yup.string().required(),
      quantity: yup.number().positive().integer().required(),
      price: yup.number().positive().required(),
    })
  ).min(1).required(),
  shipping: yup.object().when("orderType", {
    is: "standard",
    then: (schema) => schema.shape({
      method: yup.string().oneOf(["ground", "air"]).required(),
      estimatedDays: yup.number().min(3).max(10).required(),
    }),
    otherwise: (schema) => schema.shape({
      method: yup.string().oneOf(["priority", "express"]).required(),
      estimatedDays: yup.number().min(1).max(2).required(),
    }),
  }),
  discount: yup.object({
    code: yup.string().optional(),
    percentage: yup.number().min(0).max(100).when("code", {
      is: (code: any) => !!code,
      then: (schema) => schema.required(),
      otherwise: (schema) => schema.optional(),
    }),
  }).optional(),
  customerNotes: yup.string().max(500).optional(),
});

export const yupConditionalTask = schemaTask({
  id: "yup-conditional-task",
  schema: orderValidationSchema,
  run: async (payload, { ctx }) => {
    // Type inference with conditional validation
    const orderType = payload.orderType;
    const itemCount = payload.items.length;
    const totalQuantity = payload.items.reduce((sum, item) => sum + item.quantity, 0);
    const totalPrice = payload.items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    
    // Shipping details based on order type
    const shippingMethod = payload.shipping.method;
    const estimatedDays = payload.shipping.estimatedDays;
    
    // Optional discount
    const hasDiscount = !!payload.discount?.code;
    const discountPercentage = payload.discount?.percentage ?? 0;
    const discountAmount = hasDiscount ? (totalPrice * discountPercentage / 100) : 0;

    return {
      orderId: `order_${ctx.run.id}`,
      orderType,
      itemCount,
      totalQuantity,
      subtotal: totalPrice,
      discount: discountAmount,
      total: totalPrice - discountAmount,
      shipping: {
        method: shippingMethod,
        estimatedDelivery: new Date(Date.now() + estimatedDays * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
  },
});

// Test Yup with custom validation and transforms
const userRegistrationSchema = yup.object({
  username: yup.string()
    .required()
    .min(3)
    .max(20)
    .matches(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
    .test("no-reserved", "Username is reserved", (value) => {
      const reserved = ["admin", "root", "system", "user"];
      return !reserved.includes(value?.toLowerCase() ?? "");
    }),
  email: yup.string()
    .email()
    .required()
    .test("email-domain", "Email domain not allowed", (value) => {
      const blockedDomains = ["tempmail.com", "throwaway.email"];
      const domain = value?.split("@")[1]?.toLowerCase();
      return !blockedDomains.includes(domain ?? "");
    }),
  password: yup.string()
    .required()
    .min(8)
    .matches(/[A-Z]/, "Password must contain at least one uppercase letter")
    .matches(/[a-z]/, "Password must contain at least one lowercase letter")
    .matches(/[0-9]/, "Password must contain at least one number")
    .matches(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
  confirmPassword: yup.string()
    .required()
    .oneOf([yup.ref("password")], "Passwords must match"),
  dateOfBirth: yup.date()
    .required()
    .max(new Date(), "Date of birth cannot be in the future")
    .test("age", "Must be at least 18 years old", (value) => {
      if (!value) return false;
      const age = new Date().getFullYear() - value.getFullYear();
      return age >= 18;
    }),
  termsAccepted: yup.boolean()
    .required()
    .oneOf([true], "You must accept the terms and conditions"),
});

export const yupCustomValidationTask = schemaTask({
  id: "yup-custom-validation-task",
  schema: userRegistrationSchema,
  run: async (payload, { ctx }) => {
    // All validations have passed if we get here
    const username: string = payload.username;
    const email: string = payload.email;
    const dateOfBirth: Date = payload.dateOfBirth;
    const termsAccepted: boolean = payload.termsAccepted;
    
    // Calculate age
    const age = new Date().getFullYear() - dateOfBirth.getFullYear();
    
    return {
      userId: `user_${ctx.run.id}`,
      username,
      email,
      age,
      registeredAt: new Date().toISOString(),
      welcomeEmailRequired: true,
    };
  },
});