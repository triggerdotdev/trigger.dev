import { Link } from "@remix-run/react";
import { Header } from "~/components/Header";
import { AppBody } from "~/components/layout/AppLayout";
import { useOrganizations } from "~/hooks/useOrganizations";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <Header>Home</Header>
      <AppBody>
        <ul className="grid grid-cols-3">
          {organizations ? (
            organizations.map((organization) => (
              <li key={organization.id}>
                <Link to={`orgs/${organization.slug}`}>
                  {organization.title}
                </Link>
              </li>
            ))
          ) : (
            <li>No organizations</li>
          )}
          <li>
            <Link to="orgs/new">Create a new organization</Link>
          </li>
        </ul>
      </AppBody>
    </>
  );
}
