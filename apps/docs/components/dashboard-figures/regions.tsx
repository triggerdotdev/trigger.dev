// The Regions page: the project's regions, with us-east-1 the default and the us-east-1-next row
// hovered to show its MicroVM badge and the Set as default… button. Drawn from source (the
// reference dashboard only has local-dev); the table classes match a capture of the live page.
// Readers aren't admins, so the Admin column is left out, and the plan is a free one, so static
// IPs show Unlock static IPs. The webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import {
  ArrowUpCircleIcon,
  ChatBubbleLeftEllipsisIcon,
  MapPinIcon,
} from "@heroicons/react/20/solid";
import { AppFrame, Button, PageHeader, SideMenu, tableHeader, tableRow, th } from "./chrome";
import * as I from "./icons";

type P = { className?: string };

/** CloudProviderIcon AWS; the wordmark uses currentColor (white in the dashboard's dark theme). */
function AwsIcon({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 240 240" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M67.6343 100.132C67.5545 102.527 67.8738 104.921 68.5123 107.236C69.2307 109.232 70.1088 111.147 71.0666 112.983C71.3859 113.542 71.6254 114.181 71.6254 114.819C71.5455 115.777 70.9868 116.735 70.1088 117.214L65.08 120.566C64.4414 120.965 63.723 121.285 63.0046 121.285C62.1266 121.205 61.2486 120.806 60.61 120.167C59.5723 119.05 58.5346 117.773 57.7364 116.416C56.9382 115.059 56.14 113.542 55.2619 111.706C49.0359 119.05 41.2134 122.722 31.7944 122.722C25.0894 122.722 19.7414 120.806 15.8301 116.974C11.9189 113.143 9.92334 108.034 9.92334 101.649C9.92334 94.8638 12.318 89.3561 17.1871 85.2054C22.0562 81.0547 28.5217 78.9793 36.7434 78.9793C39.5371 78.9793 42.4107 79.2188 45.2044 79.6179C48.1578 80.017 51.1911 80.6556 54.3839 81.374V75.547C54.3839 69.4806 53.1068 65.25 50.6323 62.7756C48.1578 60.3011 43.7677 59.1038 37.6214 59.1038C34.7478 59.1038 31.7944 59.4231 29.0007 60.1415C26.0473 60.8598 23.1737 61.7379 20.38 62.8554C19.5019 63.2545 18.5441 63.5738 17.5862 63.8931C17.1871 64.0527 16.7082 64.1325 16.3091 64.1325C15.1916 64.1325 14.6328 63.3343 14.6328 61.6581V57.7468C14.553 56.7889 14.7925 55.8311 15.1916 54.9531C15.8301 54.2347 16.5485 53.6759 17.4266 53.2768C20.6194 51.6804 23.9719 50.483 27.4841 49.6848C31.555 48.6472 35.7855 48.1682 39.9362 48.1682C49.435 48.1682 56.3795 50.3234 60.8495 54.6338C65.3195 58.9441 67.4746 65.4895 67.4746 74.2699V100.132H67.6343ZM35.2268 112.265C38.0205 112.265 40.8143 111.786 43.4484 110.828C46.4018 109.79 48.9561 108.034 51.0314 105.72C52.3086 104.283 53.2664 102.527 53.7453 100.611C54.3041 98.376 54.5436 95.9813 54.5436 93.6665V90.314C52.1489 89.7552 49.6744 89.2763 47.2 88.957C44.7255 88.6377 42.1712 88.4781 39.6968 88.4781C34.3487 88.4781 30.4375 89.5158 27.8034 91.6709C25.1692 93.8261 23.8921 96.8593 23.8921 100.85C23.8921 104.602 24.85 107.396 26.8455 109.312C28.841 111.227 31.555 112.265 35.2268 112.265ZM99.3234 120.886C98.2857 120.965 97.1682 120.726 96.2902 120.087C95.492 119.209 94.8534 118.172 94.614 116.974L75.8559 55.2723C75.4568 54.2347 75.2173 53.197 75.1375 52.0795C75.0577 51.1216 75.6963 50.2436 76.6541 50.0839H84.9556C86.4722 50.0839 87.5098 50.3234 88.0686 50.8822C88.6273 51.4409 89.1861 52.4786 89.665 53.9952L102.995 106.837L115.447 53.9952C115.846 52.3988 116.325 51.3611 116.964 50.8822C117.922 50.3234 119.039 50.0041 120.157 50.0839H126.543C128.059 50.0839 129.097 50.3234 129.735 50.8822C130.534 51.7602 131.092 52.7979 131.252 53.9952L143.864 107.476L157.673 53.9952C157.912 52.7979 158.471 51.7602 159.269 50.8822C160.227 50.3234 161.265 50.0041 162.382 50.0839H169.806C170.764 49.9243 171.642 50.6427 171.801 51.6005V52.0795C171.801 52.4786 171.722 52.9575 171.642 53.3566C171.482 54.075 171.322 54.7136 171.083 55.3522L151.846 117.054C151.367 118.651 150.808 119.688 150.17 120.167C149.292 120.726 148.174 121.045 147.137 120.965H140.272C138.755 120.965 137.718 120.726 137.079 120.167C136.281 119.289 135.722 118.172 135.562 116.974L123.19 65.4895L110.898 116.895C110.738 118.092 110.179 119.209 109.381 120.087C108.423 120.726 107.306 120.965 106.188 120.886H99.3234ZM201.894 123.041C197.743 123.041 193.593 122.562 189.602 121.604C185.61 120.646 182.497 119.608 180.422 118.411C179.384 117.932 178.506 117.134 177.948 116.176C177.628 115.458 177.469 114.739 177.469 113.941V109.87C177.469 108.194 178.107 107.396 179.305 107.396C179.784 107.396 180.262 107.476 180.741 107.635C181.22 107.795 181.939 108.114 182.737 108.433C185.531 109.711 188.484 110.589 191.517 111.227C194.63 111.866 197.823 112.185 201.016 112.185C206.045 112.185 209.956 111.307 212.67 109.551C215.304 107.955 216.901 105.081 216.821 101.968C216.901 99.8926 216.102 97.897 214.665 96.3804C213.229 94.8638 210.515 93.5068 206.604 92.2297L195.029 88.6377C189.202 86.8018 184.892 84.0879 182.258 80.4959C179.704 77.1434 178.267 73.1524 178.267 68.9218C178.187 65.8088 178.905 62.7756 180.422 60.0616C181.859 57.5073 183.775 55.2723 186.169 53.5163C188.644 51.6005 191.437 50.2436 194.471 49.3655C197.743 48.4077 201.096 47.9288 204.528 48.0086C206.284 48.0086 208.12 48.0884 209.876 48.3279C211.712 48.5673 213.388 48.8866 215.065 49.2059C216.741 49.5252 218.178 50.0041 219.614 50.483C220.812 50.8822 221.929 51.3611 222.967 51.9198C223.925 52.3988 224.723 53.0373 225.362 53.9154C225.92 54.7136 226.16 55.5916 226.08 56.5495V60.3011C226.08 61.9773 225.441 62.8554 224.244 62.8554C223.206 62.6957 222.169 62.3765 221.211 61.8975C216.422 59.7423 211.153 58.7047 205.885 58.7845C201.335 58.7845 197.743 59.5029 195.269 61.0195C192.794 62.5361 191.517 64.8509 191.517 68.1236C191.437 70.2788 192.315 72.3541 193.912 73.7909C195.508 75.3075 198.462 76.8241 202.692 78.1811L214.027 81.7731C219.774 83.609 223.925 86.1633 226.399 89.4359C228.874 92.6288 230.151 96.6199 230.071 100.611C230.151 103.804 229.432 106.997 227.996 109.87C226.559 112.584 224.563 114.979 222.169 116.895C219.535 118.97 216.501 120.487 213.309 121.365C209.637 122.482 205.805 123.041 201.894 123.041Z"
        fill="currentColor"
      />
      <path
        d="M216.98 161.834C190.719 181.231 152.564 191.528 119.758 191.528C73.7806 191.528 32.3533 174.526 1.06324 146.269C-1.41123 144.034 0.823772 141.001 3.77717 142.757C37.6215 162.393 79.3681 174.286 122.552 174.286C153.682 174.126 184.493 167.821 213.149 155.768C217.539 153.772 221.291 158.641 216.98 161.834Z"
        fill="#FF9900"
      />
      <path
        d="M227.916 149.382C224.563 145.072 205.726 147.307 197.185 148.344C194.63 148.664 194.231 146.428 196.546 144.752C211.553 134.216 236.217 137.249 239.091 140.761C241.965 144.273 238.293 169.018 224.244 180.832C222.089 182.667 220.014 181.71 220.971 179.315C224.164 171.413 231.268 153.612 227.916 149.382Z"
        fill="#FF9900"
      />
    </svg>
  );
}

/** RegionIcons FlagUSA */
function FlagUSA({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 96 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#fig_regions_flag_usa)">
        <rect x="0.09375" width="95.9062" height="71.9297" rx="5.99414" fill="white" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M0.09375 0V8.0065H96.0937V0H0.09375Z"
          fill="#E31D1C"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M0.09375 16.0131V24.0196H96.0937V16.0131H0.09375Z"
          fill="#E31D1C"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M0.09375 31.9791V39.9856H96.0937V31.9791H0.09375Z"
          fill="#E31D1C"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M0.09375 47.9921V55.9986H96.0937V47.9921H0.09375Z"
          fill="#E31D1C"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M0.09375 63.9584V71.9649H96.0937V63.9584H0.09375Z"
          fill="#E31D1C"
        />
        <rect x="0.09375" width="60" height="40" fill="#2E52B2" />
        <path
          d="M50.9424 29.8628H53.0938L51.4033 31.5835L52.0576 34.2974L49.9531 32.772L47.7773 34.2974L48.5117 31.5835L46.5791 29.8628H49.1035L49.9502 27.6479L50.9424 29.8628ZM11.3486 29.2515H13.5L11.8096 30.9712L12.4639 33.686L10.3594 32.1606L8.18359 33.686L8.91797 30.9712L6.98633 29.2515H9.50977L10.3564 27.0366L11.3486 29.2515ZM24.5469 29.2515H26.6982L25.0078 30.9712L25.6621 33.686L23.5566 32.1606L21.3818 33.686L22.1162 30.9712L20.1836 29.2515H22.708L23.5537 27.0366L24.5469 29.2515ZM37.7441 29.2515H39.8955L38.2051 30.9712L38.8604 33.686L36.7549 32.1606L34.5791 33.686L35.3135 30.9712L33.3818 29.2515H35.9053L36.752 27.0366L37.7441 29.2515ZM50.9424 18.9077H53.0938L51.4033 20.6284L52.0576 23.3423L49.9521 21.8169L47.7773 23.3423L48.5117 20.6284L46.5791 18.9077H49.1025L49.9492 16.6929L50.9424 18.9077ZM11.3486 18.6021H13.5L11.8096 20.3218L12.4639 23.0366L10.3594 21.5112L8.18359 23.0366L8.91797 20.3218L6.98535 18.6021H9.50977L10.3555 16.3872L11.3486 18.6021ZM24.5459 18.6021H26.6973L25.0068 20.3218L25.6621 23.0366L23.5566 21.5112L21.3809 23.0366L22.1152 20.3218L20.1836 18.6021H22.707L23.5537 16.3872L24.5459 18.6021ZM37.7441 18.6021H39.8955L38.2051 20.3218L38.8594 23.0366L36.7549 21.5112L34.5791 23.0366L35.3135 20.3218L33.3809 18.6021H35.9053L36.752 16.3872L37.7441 18.6021ZM11.3486 7.95264H13.5L11.8096 9.67334L12.4639 12.3872L10.3594 10.8618L8.18359 12.3872L8.91797 9.67334L6.98535 7.95264H9.50977L10.3555 5.73779L11.3486 7.95264ZM24.5459 7.95264H26.6973L25.0068 9.67334L25.6621 12.3872L23.5566 10.8618L21.3809 12.3872L22.1152 9.67334L20.1836 7.95264H22.707L23.5537 5.73779L24.5459 7.95264ZM37.7441 7.95264H39.8955L38.2051 9.67334L38.8594 12.3872L36.7549 10.8618L34.5791 12.3872L35.3135 9.67334L33.3809 7.95264H35.9053L36.752 5.73779L37.7441 7.95264ZM50.9424 7.95264H53.0938L51.4033 9.67334L52.0576 12.3872L49.9521 10.8618L47.7773 12.3872L48.5117 9.67334L46.5791 7.95264H49.1025L49.9492 5.73779L50.9424 7.95264Z"
          fill="white"
        />
      </g>
      <defs>
        <clipPath id="fig_regions_flag_usa">
          <rect x="0.09375" width="95.9062" height="71.9297" rx="5.99414" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

/** RegionIcons FlagEurope */
function FlagEurope({ className }: P) {
  return (
    <svg className={className} viewBox="0 0 96 72" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.09375" width="95.9062" height="71.9297" rx="5.99414" fill="#2E52B2" />
      <path
        d="M30.1359 9.60876L28.2171 15.508H22.017L27.0358 19.1573L25.1171 25.0565L30.1359 21.4072L35.1547 25.0565L33.236 19.1573L38.2548 15.508H32.0546L30.1359 9.60876Z"
        fill="#F6CD46"
      />
      <path
        d="M48.0469 2.29382L46.1282 8.19302H39.928L44.9468 11.8424L43.0281 17.7416L48.0469 14.0922L53.0657 17.7416L51.147 11.8424L56.1658 8.19302H49.9656L48.0469 2.29382Z"
        fill="#F6CD46"
      />
      <path
        d="M65.9577 10.0177L64.039 15.9169H57.8388L62.8576 19.5663L60.9389 25.4655L65.9577 21.8161L70.9766 25.4655L69.0578 19.5663L74.0766 15.9169H67.8765L65.9577 10.0177Z"
        fill="#F6CD46"
      />
      <path
        d="M73.5861 27.4231L71.6673 33.3223H65.4672L70.486 36.9717L68.5672 42.8709L73.5861 39.2215L78.6049 42.8709L76.6862 36.9717L81.705 33.3223H75.5048L73.5861 27.4231Z"
        fill="#F6CD46"
      />
      <path
        d="M65.9577 46.0563L64.039 51.9555H57.8388L62.8576 55.6048L60.9389 61.504L65.9577 57.8547L70.9766 61.504L69.0578 55.6048L74.0766 51.9555H67.8765L65.9577 46.0563Z"
        fill="#F6CD46"
      />
      <path
        d="M48.0469 53.7802L46.1282 59.6794H39.928L44.9468 63.3287L43.0281 69.2279L48.0469 65.5785L53.0657 69.2279L51.147 63.3287L56.1658 59.6794H49.9656L48.0469 53.7802Z"
        fill="#F6CD46"
      />
      <path
        d="M30.1359 46.0563L28.2171 51.9555H22.017L27.0358 55.6048L25.1171 61.504L30.1359 57.8547L35.1547 61.504L33.236 55.6048L38.2548 51.9555H32.0546L30.1359 46.0563Z"
        fill="#F6CD46"
      />
      <path
        d="M22.5077 27.4231L20.589 33.3223H14.3888L19.4076 36.9717L17.4889 42.8709L22.5077 39.2215L27.5266 42.8709L25.6078 36.9717L30.6266 33.3223H24.4265L22.5077 27.4231Z"
        fill="#F6CD46"
      />
    </svg>
  );
}

type Region = {
  name: string;
  location: "usa" | "europe";
  description: string;
  microvm?: boolean;
  isDefault?: boolean;
  /** Draw the row hovered: brighter cells and the Set as default… button. */
  hovered?: boolean;
};

// RegionsPresenter sorts by name.
const regions: Region[] = [
  { name: "eu-central-1", location: "europe", description: "Europe (Frankfurt)" },
  { name: "us-east-1", location: "usa", description: "US East (N. Virginia)", isDefault: true },
  {
    name: "us-east-1-next",
    location: "usa",
    description: "US East (N. Virginia)",
    microvm: true,
    hovered: true,
  },
];

// Table.tsx, "dimmed" variant.
const td = "table-cell align-middle text-xs";
// Badge, "small" variant.
const badge =
  "place-items-center border border-border-bright rounded-sm px-1 h-5 text-xs bg-background-bright text-blue-500 whitespace-nowrap";

function Info() {
  return (
    <div className="h-fit">
      <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
    </div>
  );
}

function RegionRow({ r }: { r: Region }) {
  const cell = `${td} ${r.hovered ? "text-text-bright bg-background-bright" : "text-text-dimmed"}`;
  const Flag = r.location === "usa" ? FlagUSA : FlagEurope;
  return (
    <div className={tableRow}>
      <div className={`${cell} px-3 py-3 text-left`}>
        <span className="flex items-center gap-2">
          <span className="relative inline-flex h-6 items-center">{r.name}</span>
          {r.microvm && (
            <div data-mark="microvm" className={`grid ${badge}`}>
              <span>MicroVM</span>
            </div>
          )}
        </span>
      </div>
      <div className={`${cell} px-3 py-3 text-left`}>
        <span className="flex items-center gap-2">
          <AwsIcon className="size-6 text-text-bright" />
          Amazon Web Services
        </span>
      </div>
      <div className={`${cell} px-3 py-3 text-left`}>
        <span className="flex items-center gap-2">
          <Flag className="size-5" />
          {r.description}
        </span>
      </div>
      <div className={`${cell} px-3 py-3 text-left`}>
        <Button icon={ArrowUpCircleIcon} iconClassName="-mx-1 text-indigo-500">
          Unlock static IPs
        </Button>
      </div>
      {r.isDefault ? (
        <div className={`${cell} px-3 py-3 text-right`}>
          <div className={`inline-grid ${badge}`}>
            <span>Default</span>
          </div>
        </div>
      ) : (
        // TableCellMenu (sticky, pl-32) with hiddenButtons: Set as default… shows while the row is hovered.
        <div
          className={`${td} text-right sticky right-0 w-auto pl-32 ${r.hovered ? "text-text-bright bg-background-bright z-10" : "text-text-dimmed bg-background-dimmed"}`}
        >
          <div className="relative h-full p-1">
            {r.hovered && (
              <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 ring-1 bg-background-bright ring-grid-bright">
                <div className="block">
                  <div className="flex items-center gap-x-0.5 divide-x divide-grid-bright">
                    <Button
                      variant="minimal"
                      icon={MapPinIcon}
                      iconClassName="text-blue-500"
                      className="pl-2"
                      mark="set-default"
                      markBadge="left"
                    >
                      <span className="text-text-bright">Set as default…</span>
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RegionsFigure() {
  return (
    <AppFrame menu={<SideMenu active="Regions" open={["Deployments"]} />}>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <PageHeader title="Regions" />
        <div>
          <div className="whitespace-nowrap overflow-hidden border-t">
            <div className="table w-full">
              <div className={tableHeader}>
                <div className={tableRow}>
                  <div className={`${th} text-left`}>Region</div>
                  <div className={`${th} text-left`}>Cloud Provider</div>
                  <div className={`${th} text-left`}>
                    <span className="flex items-center gap-1">
                      Location
                      <Info />
                    </span>
                  </div>
                  <div className={`${th} text-left`}>Static IPs</div>
                  <div className={`${th} text-right`}>
                    <div className="flex items-center gap-1 justify-end">
                      Default region
                      <Info />
                    </div>
                  </div>
                </div>
              </div>
              <div className="table-row-group relative">
                {regions.map((r) => (
                  <RegionRow key={r.name} r={r} />
                ))}
                <div className={`${tableRow} h-12.5`}>
                  {/* colSpan={4} in a real table; here the empty cells hold the columns. */}
                  <div className={`${td} text-text-dimmed px-3 py-3 text-left`}>
                    <div className="font-sans text-xs font-medium text-text-dimmed">
                      Suggest a new region
                    </div>
                  </div>
                  <div className={td} />
                  <div className={td} />
                  <div className={td} />
                  <div className={`${td} text-right sticky right-0 bg-background-dimmed`}>
                    <div className="relative h-full p-1">
                      <div className="absolute right-0 top-1/2 mr-1 flex -translate-y-1/2 items-center justify-end gap-0.5 rounded-[0.25rem] p-0.5 bg-background-dimmed">
                        <Button
                          icon={ChatBubbleLeftEllipsisIcon}
                          iconClassName="-mx-1 text-indigo-500"
                        >
                          Suggest a region…
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* InfoPanel, "minimal" variant (managed cloud only). */}
          <div className="w-full py-3 px-3 max-w-full gap-1 flex h-fit items-start">
            <div className="flex items-center gap-2">
              <I.InformationCircleIcon className="size-4" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="font-sans text-xs font-medium text-text-dimmed">
                Trigger.dev is fully <span className="text-text-link">GDPR compliant</span>. Learn
                more in our <span className="text-text-link">security portal</span> or{" "}
                <span className="text-text-link">get in touch</span>.
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
