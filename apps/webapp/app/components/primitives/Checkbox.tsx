import { Badge } from "./Badge";

export function Checkbox() {
  return (
    <div>
      <input
        type="checkbox"
        name="scopes"
        value="Scopes name"
        id="123"
        defaultChecked={false}
        className="mt-1"
      />
      <div>
        <div className="flex gap-2">
          <label htmlFor="123">Scopes name</label>
          <Badge
            className="px-1.5 py-0.5 text-xs"
            // style={{ backgroundColor: a.color }}
          >
            Badge
          </Badge>
        </div>
        <p className="text-slate-300">admin:repo_hook, public_repo</p>
      </div>
    </div>
  );
}
