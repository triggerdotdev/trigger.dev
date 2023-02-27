import { catalog } from "integrations/catalog";
import { generateService } from "./generateService";

export async function generate() {
  console.log("Generating SDKs...");

  const services = Object.values(catalog.services);
  for (let index = 0; index < services.length; index++) {
    const service = services[index];
    await generateService(service);
  }

  console.log(`Generated ${services.length} SDKs`);
}

generate();
