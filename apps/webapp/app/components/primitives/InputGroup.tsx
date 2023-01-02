import classNames from "classnames";

type InputGroupProps = {
  layout?: "vertical" | "horizontal";
  children: React.ReactNode;
};

export function InputGroup({ layout = "vertical", children }: InputGroupProps) {
  return (
    <div
      className={classNames(
        "grid gap-1 mb-2",
        layout === "horizontal" ? "grid-cols-2" : "grid-cols-1"
      )}
    >
      {children}
    </div>
  );
}
