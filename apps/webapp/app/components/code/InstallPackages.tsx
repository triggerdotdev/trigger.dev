import {
  ClientTabs,
  ClientTabsList,
  ClientTabsTrigger,
  ClientTabsContent,
} from "../primitives/ClientTabs";
import { ClipboardField } from "../primitives/ClipboardField";

type InstallPackagesProps = {
  packages: string[];
};

export function InstallPackages({ packages }: InstallPackagesProps) {
  return (
    <ClientTabs defaultValue="npm">
      <ClientTabsList>
        <ClientTabsTrigger value={"npm"}>npm</ClientTabsTrigger>
        <ClientTabsTrigger value={"pnpm"}>pnpm</ClientTabsTrigger>
        <ClientTabsTrigger value={"yarn"}>yarn</ClientTabsTrigger>
      </ClientTabsList>
      <ClientTabsContent value={"npm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`npm install ${packages.join(" ")}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"pnpm"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`pnpm install ${packages.join(" ")}`}
        />
      </ClientTabsContent>
      <ClientTabsContent value={"yarn"}>
        <ClipboardField
          variant="primary/medium"
          className="mb-4"
          value={`yarn add ${packages.join(" ")}`}
        />
      </ClientTabsContent>
    </ClientTabs>
  );
}
