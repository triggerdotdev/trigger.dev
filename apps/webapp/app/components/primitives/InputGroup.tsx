import classNames from "classnames";

type InputGroupProps = {
  layout?: "vertical" | "horizontal";
  children: React.ReactNode;
  className?: string;
};

export function InputGroup({
  layout = "vertical",
  children,
  className,
}: InputGroupProps) {
  return (
    <div
      className={classNames(
        "mb-2 grid gap-1",
        { className },
        layout === "horizontal" ? "grid-cols-2" : "grid-cols-1"
      )}
    >
      {children}
    </div>
  );
}
