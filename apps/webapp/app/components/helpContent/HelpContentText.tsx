import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";

export function HowToConnectAnIntegration() {
  return (
    <>
      <StepNumber stepNumber="1" title="Select an Integration from the list" />
      <StepContentContainer>
        <Paragraph variant="small">Content</Paragraph>
      </StepContentContainer>
    </>
  );
}

export function HowToCreateAJob() {
  return (
    <>
      <StepNumber stepNumber="1" title="Step 1 title" />
      <StepContentContainer>
        <Paragraph variant="small">How to create a Job content</Paragraph>
      </StepContentContainer>
    </>
  );
}

function StepContentContainer({ children }: { children: React.ReactNode }) {
  return <div className="ml-9 mt-1">{children}</div>;
}
