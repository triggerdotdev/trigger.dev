import { Hr, Link, Tailwind, Text } from "@react-email/components";
import { hr } from "./styles";

export function Footer() {
  return (
    <>
      <Hr style={hr} />
      <Text className="text-[12px] text-[#878C99]">
        ©Trigger.dev, 1111B S Governors Ave STE 6433, Dover, DE 19904 |{" "}
        <Link className="text-[#878C99] text-[12px] underline" href="https://trigger.dev/">
          Trigger.dev
        </Link>
      </Text>
    </>
  );
}
