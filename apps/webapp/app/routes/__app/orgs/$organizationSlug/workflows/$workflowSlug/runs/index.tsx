import { Link } from "@remix-run/react";
import { Header1 } from "~/components/primitives/text/Headers";

export default function Page() {
  return (
    <>
      <Header1>Runs</Header1>
      <div>Runs table will go here</div>
      <Link to="abdefg" className="underline">
        Example run
      </Link>
    </>
  );
}
