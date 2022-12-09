import { useCallback } from "react";
const Pizzly = require("@nangohq/pizzly-frontend");

export default function Integrations() {
  const authenticateWithGitHub = useCallback(async () => {
    const pizzly = new Pizzly("http://localhost:3004");
    pizzly
      .auth("github", "test-connection")
      .then((result: any) => {
        console.log(
          `OAuth flow succeeded for provider "${result.providerConfigKey}" and connection-id "${result.connectionId}"!`
        );
      })
      .catch((error: any) => {
        console.error(
          `There was an error in the OAuth flow for integration "${error.providerConfigKey}" and connection-id "${error.connectionId}": ${error.error.type} - ${error.error.message}`
        );
      });
  }, []);

  return (
    <div>
      <h1>Integrations</h1>
      <button onClick={() => authenticateWithGitHub()}>
        Connect to GitHub
      </button>
    </div>
  );
}
