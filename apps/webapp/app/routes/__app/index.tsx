import { Link } from "@remix-run/react";
import { Header } from "~/components/Header";
import { useOrganizations } from "~/hooks/useOrganizations";

export default function AppLayout() {
  const organizations = useOrganizations();

  return (
    <>
      <Header>Home</Header>
      <ul className="flex h-screen flex-col overflow-auto">
        {organizations ? (
          organizations.map((organization) => (
            <li key={organization.id}>
              <Link to={`orgs/${organization.slug}`}>{organization.title}</Link>
            </li>
          ))
        ) : (
          <li>No organizations</li>
        )}
        <li>
          <Link to="orgs/new">Create a new organization</Link>
        </li>
      </ul>
    </>
  );
}
