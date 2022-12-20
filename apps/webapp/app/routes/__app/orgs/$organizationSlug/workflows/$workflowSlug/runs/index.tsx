import {
  CheckIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import classNames from "classnames";
import { Panel } from "~/components/layout/Panel";
import { Spinner } from "~/components/primitives/Spinner";
import { Header1, Header2 } from "~/components/primitives/text/Headers";

const headerCell = "px-4 py-5 text-left text-base font-semibold text-slate-300";
const headerCellRightAlign = classNames(headerCell, "text-right");
const cell = "flex whitespace-nowrap text-sm text-slate-300";
const cellLeftAligned = classNames(cell, "justify-start");
const cellRightAligned = classNames(cell, "justify-end");

export default function Page() {
  return (
    <>
      <Header1 className="mb-6">Runs</Header1>
      <Header2 size="small" className="mb-2 text-slate-400">
        20 runs of 530
      </Header2>
      <Panel className="p-0 overflow-hidden overflow-x-auto">
        <table className="w-full divide-y divide-slate-850">
          <thead className="bg-slate-700/20">
            <tr>
              <th scope="col" className={headerCell}>
                ID
              </th>
              <th scope="col" className={headerCell}>
                Status
              </th>
              <th scope="col" className={headerCell}>
                Started
              </th>
              <th scope="col" className={headerCell}>
                Completed
              </th>
              <th scope="col" className={headerCellRightAlign}>
                Duration
              </th>
              <th scope="col" className={headerCellRightAlign}>
                Test
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-850">
            <tr className="group w-full">
              <Cell to="abcdef" alignment="left">
                clbuoggr500047cw95pv8r1oh
              </Cell>
              <Cell to="abcdef" alignment="left">
                <span className="flex items-center gap-1">
                  <Spinner className="w-4 h-4 text-green-500" />
                  In progress
                </span>
              </Cell>
              <Cell to="abcdef" alignment="left">
                12:45pm 22 Dec 2022
              </Cell>
              <Cell to="abcdef" alignment="left">
                –
              </Cell>
              <Cell to="abcdef">–</Cell>
              <Cell to="abcdef">
                <CheckIcon className="h-5 w-5 text-green-500" />
              </Cell>
            </tr>
            <tr className="group w-full">
              <Cell to="abcdef" alignment="left">
                clbuoggr500047cw95pv8r1oh
              </Cell>
              <Cell to="abcdef" alignment="left">
                <span className="flex items-center gap-1 justify-end">
                  <CheckCircleIcon className="w-4 h-4 text-green-500" />
                  Complete
                </span>
              </Cell>
              <Cell to="abcdef" alignment="left">
                12:45pm 22 Dec 2022
              </Cell>
              <Cell to="abcdef" alignment="left">
                10:13am 23 Dec 2022
              </Cell>
              <Cell to="abcdef">1d 4h 44m</Cell>
              <Cell to="abcdef">–</Cell>
            </tr>
            <tr className="group w-full">
              <Cell to="abcdef" alignment="left">
                clbuoggr500047cw95pv8r1oh
              </Cell>
              <Cell to="abcdef" alignment="left">
                <span className="flex items-center gap-1 justify-end">
                  <ExclamationTriangleIcon className="flex justify-self-end h-4 w-4 text-red-600" />
                  Error
                </span>
              </Cell>
              <Cell to="abcdef" alignment="left">
                12:45pm 22 Dec 2022
              </Cell>
              <Cell to="abcdef" alignment="left">
                –
              </Cell>
              <Cell to="abcdef">–</Cell>
              <Cell to="abcdef">–</Cell>
            </tr>
            <tr>
              <td colSpan={6} className="py-6 text-sm text-center">
                <div className="flex items-center justify-center">
                  <div className="flex items-center justify-center p-3 pr-4 gap-1 bg-yellow-200 border border-yellow-400 rounded-md text-yellow-700">
                    <InformationCircleIcon className="w-5 h-5" />
                    <span className="text-gray">
                      No runs found for this Workflow
                    </span>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function Cell({
  children,
  to,
  alignment = "right",
}: {
  children: React.ReactNode;
  to: string;
  alignment?: "left" | "right";
}) {
  return (
    <td className="group-hover:bg-slate-850/50 transition cursor-pointer">
      <Link
        to={to}
        className={classNames(
          "w-full py-3 px-4",
          alignment === "right" ? cellRightAligned : cellLeftAligned
        )}
      >
        {children}
      </Link>
    </td>
  );
}
