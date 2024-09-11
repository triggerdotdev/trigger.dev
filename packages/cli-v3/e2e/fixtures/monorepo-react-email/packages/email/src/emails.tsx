import { Button, Html } from "@react-email/components";
import { render } from "@react-email/render";

function ExampleEmail(props: {}) {
  return (
    <Html>
      <Button
        href="https://example.com"
        style={{ background: "#000", color: "#fff", padding: "12px 20px" }}
      >
        Click me
      </Button>
    </Html>
  );
}

export function renderExampleEmail() {
  return render(<ExampleEmail />);
}
