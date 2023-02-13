import { catalog } from "integrations/catalog";
import { generateService } from "./generateService";

export async function generate() {
  console.log("Generating SDKs...");

  const allSdks = Object.values(catalog.services).map((service) => {
    return generateService(service);
  });

  await Promise.all(allSdks);

  console.log(`Generated ${allSdks.length} SDKs`);
}

generate();
