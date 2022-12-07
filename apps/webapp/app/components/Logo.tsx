import logoImage from "../assets/images/logo.png";

export function Logo({
  className,
  width = "100%",
}: {
  className?: string;
  width?: string;
}) {
  return <img src={logoImage} alt="Logo" className={className} width={width} />;
}
