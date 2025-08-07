export function cloudProviderTitle(provider: "aws" | "digitalocean" | (string & {})) {
  switch (provider) {
    case "aws":
      return "Amazon Web Services";
    case "digitalocean":
      return "Digital Ocean";
    default:
      return provider;
  }
}
