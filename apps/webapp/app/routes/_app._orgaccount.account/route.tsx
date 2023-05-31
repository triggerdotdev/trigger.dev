import { useUser } from "~/hooks/useUser";

export default function Page() {
  const user = useUser();

  return <div>{user.name}</div>;
}
