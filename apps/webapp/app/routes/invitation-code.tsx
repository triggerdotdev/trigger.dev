import {
  AppContainer,
  MainCenteredContainer,
} from "~/components/layout/AppLayout";
import { NavBar } from "~/components/navigation/NavBar";

export default function Page() {
  return (
    <AppContainer showBackgroundGradient={true}>
      <NavBar />
      <MainCenteredContainer>
        <div>Enter your invitation code to get access to the cloud.</div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
