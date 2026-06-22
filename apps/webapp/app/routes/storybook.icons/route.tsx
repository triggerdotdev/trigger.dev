import { type ComponentType, type ReactNode } from "react";
import { AbacusIcon } from "~/assets/icons/AbacusIcon";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { AIPenIcon } from "~/assets/icons/AIPenIcon";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import {
  AnthropicIcon,
  AzureIcon,
  CerebrasIcon,
  DeepseekIcon,
  GeminiIcon,
  LlamaIcon,
  MistralIcon,
  OpenAIIcon,
  PerplexityIcon,
  XAIIcon,
} from "~/assets/icons/AiProviderIcons";
import { AnthropicLogoIcon } from "~/assets/icons/AnthropicLogoIcon";
import { ArchiveIcon, UnarchiveIcon } from "~/assets/icons/ArchiveIcon";
import { ArrowLeftRightIcon } from "~/assets/icons/ArrowLeftRightIcon";
import { ArrowRightSquareIcon } from "~/assets/icons/ArrowRightSquareIcon";
import { ArrowTopRightBottomLeftIcon } from "~/assets/icons/ArrowTopRightBottomLeftIcon";
import { AttemptIcon } from "~/assets/icons/AttemptIcon";
import { AvatarCircleIcon } from "~/assets/icons/AvatarCircleIcon";
import { BatchesIcon } from "~/assets/icons/BatchesIcon";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { BellIcon } from "~/assets/icons/BellIcon";
import { BookIcon } from "~/assets/icons/BookIcon";
import { Box3DIcon } from "~/assets/icons/Box3DIcon";
import { BugIcon } from "~/assets/icons/BugIcon";
import { BulbIcon } from "~/assets/icons/BulbIcon";
import { BunLogoIcon } from "~/assets/icons/BunLogoIcon";
import { ChartArrowIcon } from "~/assets/icons/ChartArrowIcon";
import { ChartBarIcon } from "~/assets/icons/ChartBarIcon";
import { ChevronExtraSmallDown } from "~/assets/icons/ChevronExtraSmallDown";
import { ChevronExtraSmallUp } from "~/assets/icons/ChevronExtraSmallUp";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import { AWS, DigitalOcean } from "~/assets/icons/CloudProviderIcon";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import {
  CheckingConnectionIcon,
  ConnectedIcon,
  DisconnectedIcon,
} from "~/assets/icons/ConnectionIcons";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { DialIcon } from "~/assets/icons/DialIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { DynamicTriggerIcon } from "~/assets/icons/DynamicTriggerIcon";
import { EndpointIcon } from "~/assets/icons/EndpointIcon";
import { EnvelopeIcon } from "~/assets/icons/EnvelopeIcon";
import {
  BranchEnvironmentIconSmall,
  DeployedEnvironmentIcon,
  DeployedEnvironmentIconSmall,
  DevEnvironmentIcon,
  DevEnvironmentIconSmall,
  PreviewEnvironmentIconSmall,
  ProdEnvironmentIcon,
  ProdEnvironmentIconSmall,
} from "~/assets/icons/EnvironmentIcons";
import { ErrorIcon } from "~/assets/icons/ErrorIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { FolderClosedIcon } from "~/assets/icons/FolderClosedIcon";
import { FolderOpenIcon } from "~/assets/icons/FolderOpenIcon";
import { FunctionIcon } from "~/assets/icons/FunctionIcon";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { HomeIcon } from "~/assets/icons/HomeIcon";
import { IDIcon } from "~/assets/icons/IDIcon";
import { InfoIcon } from "~/assets/icons/InfoIcon";
import { IntegrationsIcon } from "~/assets/icons/IntegrationsIcon";
import { KeyboardDownIcon } from "~/assets/icons/KeyboardDownIcon";
import { KeyboardEnterIcon } from "~/assets/icons/KeyboardEnterIcon";
import { KeyboardIcon } from "~/assets/icons/KeyboardIcon";
import { KeyboardLeftIcon } from "~/assets/icons/KeyboardLeftIcon";
import { KeyboardRightIcon } from "~/assets/icons/KeyboardRightIcon";
import { KeyboardUpIcon } from "~/assets/icons/KeyboardUpIcon";
import { KeyboardWindowsIcon } from "~/assets/icons/KeyboardWindowsIcon";
import { KeyIcon } from "~/assets/icons/KeyIcon";
import { KeyValueIcon } from "~/assets/icons/KeyValueIcon";
import { ListBulletIcon } from "~/assets/icons/ListBulletIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { MachineDefaultIcon } from "~/assets/icons/MachineIcon";
import { MiddlewareIcon } from "~/assets/icons/MiddlewareIcon";
import { MoveToBottomIcon } from "~/assets/icons/MoveToBottomIcon";
import { MoveToTopIcon } from "~/assets/icons/MoveToTopIcon";
import { MoveUpIcon } from "~/assets/icons/MoveUpIcon";
import { NodejsLogoIcon } from "~/assets/icons/NodejsLogoIcon";
import { OneTreeIcon } from "~/assets/icons/OneTreeIcon";
import { PadlockIcon } from "~/assets/icons/PadlockIcon";
import { PauseIcon } from "~/assets/icons/PauseIcon";
import { PlaygroundIcon } from "~/assets/icons/PlaygroundIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { PrivateIcon } from "~/assets/icons/PrivateIcon";
import { PromoteIcon } from "~/assets/icons/PromoteIcon";
import { PythonLogoIcon } from "~/assets/icons/PythonLogoIcon";
import { QuestionMarkIcon } from "~/assets/icons/QuestionMarkIcon";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { RadarPulseIcon } from "~/assets/icons/RadarPulseIcon";
import { FlagEurope, FlagUSA } from "~/assets/icons/RegionIcons";
import { RightSideMenuIcon } from "~/assets/icons/RightSideMenuIcon";
import { RolesIcon } from "~/assets/icons/RolesIcon";
import { RunFunctionIcon } from "~/assets/icons/RunFunctionIcon";
import {
  RunsIcon,
  RunsIconExtraSmall,
  RunsIconSmall,
} from "~/assets/icons/RunsIcon";
import { SaplingIcon } from "~/assets/icons/SaplingIcon";
import { ScheduleIcon } from "~/assets/icons/ScheduleIcon";
import { ShieldIcon } from "~/assets/icons/ShieldIcon";
import { ShieldLockIcon } from "~/assets/icons/ShieldLockIcon";
import {
  ShowParentIcon,
  ShowParentIconSelected,
} from "~/assets/icons/ShowParentIcon";
import { SideMenuRightClosedIcon } from "~/assets/icons/SideMenuRightClosed";
import { SlackIcon } from "~/assets/icons/SlackIcon";
import { SlackMonoIcon } from "~/assets/icons/SlackMonoIcon";
import { SlidersIcon } from "~/assets/icons/SlidersIcon";
import { SnakedArrowIcon } from "~/assets/icons/SnakedArrowIcon";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { StarIcon } from "~/assets/icons/StarIcon";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { StreamsIcon } from "~/assets/icons/StreamsIcon";
import { TableIcon } from "~/assets/icons/TableIcon";
import { TaskCachedIcon, TaskIcon, TaskIconSmall } from "~/assets/icons/TaskIcon";
import { TestTubeIcon } from "~/assets/icons/TestTubeIcon";
import { TextInlineIcon } from "~/assets/icons/TextInlineIcon";
import { TextWrapIcon } from "~/assets/icons/TextWrapIcon";
import { TimedOutIcon } from "~/assets/icons/TimedOutIcon";
import { ToggleArrowIcon } from "~/assets/icons/ToggleArrowIcon";
import { TraceIcon } from "~/assets/icons/TraceIcon";
import { TriggerIcon } from "~/assets/icons/TriggerIcon";
import { TwoTreesIcon } from "~/assets/icons/TwoTreesIcon";
import { UserCrossIcon } from "~/assets/icons/UserCrossIcon";
import { UserGroupIcon } from "~/assets/icons/UserGroupIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { WarmStartIcon } from "~/assets/icons/WarmStartIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";

type IconEntry = {
  name: string;
  render: (className: string) => ReactNode;
};

function simple(Component: ComponentType<{ className?: string }>): IconEntry["render"] {
  return (className) => <Component className={className} />;
}

const icons: IconEntry[] = [
  { name: "AbacusIcon", render: simple(AbacusIcon) },
  { name: "AIChatIcon", render: simple(AIChatIcon) },
  { name: "AIMetricsIcon", render: simple(AIMetricsIcon) },
  { name: "AIPenIcon", render: simple(AIPenIcon) },
  { name: "AISparkleIcon", render: simple(AISparkleIcon) },
  { name: "AnthropicIcon", render: simple(AnthropicIcon) },
  { name: "AnthropicLogoIcon", render: simple(AnthropicLogoIcon) },
  { name: "ArchiveIcon", render: simple(ArchiveIcon) },
  { name: "ArrowLeftRightIcon", render: simple(ArrowLeftRightIcon) },
  { name: "ArrowRightSquareIcon", render: simple(ArrowRightSquareIcon) },
  { name: "ArrowTopRightBottomLeftIcon", render: simple(ArrowTopRightBottomLeftIcon) },
  { name: "AttemptIcon", render: simple(AttemptIcon) },
  { name: "AvatarCircleIcon", render: simple(AvatarCircleIcon) },
  { name: "AWS", render: simple(AWS) },
  { name: "AzureIcon", render: simple(AzureIcon) },
  { name: "BatchesIcon", render: simple(BatchesIcon) },
  { name: "BeakerIcon", render: simple(BeakerIcon) },
  { name: "BellIcon", render: simple(BellIcon) },
  { name: "BookIcon", render: simple(BookIcon) },
  { name: "Box3DIcon", render: simple(Box3DIcon) },
  { name: "BranchEnvironmentIconSmall", render: simple(BranchEnvironmentIconSmall) },
  { name: "BugIcon", render: simple(BugIcon) },
  { name: "BulbIcon", render: simple(BulbIcon) },
  { name: "BunLogoIcon", render: simple(BunLogoIcon) },
  { name: "CerebrasIcon", render: simple(CerebrasIcon) },
  { name: "ChartArrowIcon", render: simple(ChartArrowIcon) },
  { name: "ChartBarIcon", render: simple(ChartBarIcon) },
  { name: "CheckingConnectionIcon", render: simple(CheckingConnectionIcon) },
  { name: "ChevronExtraSmallDown", render: simple(ChevronExtraSmallDown) },
  { name: "ChevronExtraSmallUp", render: simple(ChevronExtraSmallUp) },
  { name: "ClockIcon", render: simple(ClockIcon) },
  { name: "ClockRotateLeftIcon", render: simple(ClockRotateLeftIcon) },
  { name: "CodeSquareIcon", render: simple(CodeSquareIcon) },
  { name: "ConcurrencyIcon", render: simple(ConcurrencyIcon) },
  { name: "ConnectedIcon", render: simple(ConnectedIcon) },
  { name: "CubeSparkleIcon", render: simple(CubeSparkleIcon) },
  { name: "DeepseekIcon", render: simple(DeepseekIcon) },
  { name: "DeployedEnvironmentIcon", render: simple(DeployedEnvironmentIcon) },
  { name: "DeployedEnvironmentIconSmall", render: simple(DeployedEnvironmentIconSmall) },
  { name: "DeploymentsIcon", render: simple(DeploymentsIcon) },
  { name: "DevEnvironmentIcon", render: simple(DevEnvironmentIcon) },
  { name: "DevEnvironmentIconSmall", render: simple(DevEnvironmentIconSmall) },
  { name: "DialIcon", render: simple(DialIcon) },
  { name: "DigitalOcean", render: simple(DigitalOcean) },
  { name: "DisconnectedIcon", render: simple(DisconnectedIcon) },
  { name: "DropdownIcon", render: simple(DropdownIcon) },
  { name: "DynamicTriggerIcon", render: simple(DynamicTriggerIcon) },
  { name: "EndpointIcon", render: simple(EndpointIcon) },
  { name: "EnvelopeIcon", render: simple(EnvelopeIcon) },
  { name: "ErrorIcon", render: simple(ErrorIcon) },
  { name: "ExitIcon", render: simple(ExitIcon) },
  { name: "FlagEurope", render: simple(FlagEurope) },
  { name: "FlagUSA", render: simple(FlagUSA) },
  { name: "FolderClosedIcon", render: simple(FolderClosedIcon) },
  { name: "FolderOpenIcon", render: simple(FolderOpenIcon) },
  { name: "FunctionIcon", render: simple(FunctionIcon) },
  { name: "GeminiIcon", render: simple(GeminiIcon) },
  { name: "GlobeLinesIcon", render: simple(GlobeLinesIcon) },
  { name: "HomeIcon", render: simple(HomeIcon) },
  { name: "IDIcon", render: simple(IDIcon) },
  { name: "InfoIcon", render: simple(InfoIcon) },
  { name: "IntegrationsIcon", render: simple(IntegrationsIcon) },
  { name: "KeyboardDownIcon", render: simple(KeyboardDownIcon) },
  { name: "KeyboardEnterIcon", render: simple(KeyboardEnterIcon) },
  { name: "KeyboardIcon", render: simple(KeyboardIcon) },
  { name: "KeyboardLeftIcon", render: simple(KeyboardLeftIcon) },
  { name: "KeyboardRightIcon", render: simple(KeyboardRightIcon) },
  { name: "KeyboardUpIcon", render: simple(KeyboardUpIcon) },
  { name: "KeyboardWindowsIcon", render: simple(KeyboardWindowsIcon) },
  { name: "KeyIcon", render: simple(KeyIcon) },
  { name: "KeyValueIcon", render: simple(KeyValueIcon) },
  { name: "ListBulletIcon", render: simple(ListBulletIcon) },
  { name: "ListCheckedIcon", render: simple(ListCheckedIcon) },
  { name: "LlamaIcon", render: simple(LlamaIcon) },
  { name: "LogsIcon", render: simple(LogsIcon) },
  { name: "MachineDefaultIcon", render: simple(MachineDefaultIcon) },
  { name: "MiddlewareIcon", render: simple(MiddlewareIcon) },
  { name: "MistralIcon", render: simple(MistralIcon) },
  { name: "MoveToBottomIcon", render: simple(MoveToBottomIcon) },
  { name: "MoveToTopIcon", render: simple(MoveToTopIcon) },
  { name: "MoveUpIcon", render: simple(MoveUpIcon) },
  { name: "NodejsLogoIcon", render: simple(NodejsLogoIcon) },
  { name: "OneTreeIcon", render: simple(OneTreeIcon) },
  { name: "OpenAIIcon", render: simple(OpenAIIcon) },
  { name: "PadlockIcon", render: simple(PadlockIcon) },
  { name: "PauseIcon", render: simple(PauseIcon) },
  { name: "PerplexityIcon", render: simple(PerplexityIcon) },
  { name: "PlaygroundIcon", render: simple(PlaygroundIcon) },
  { name: "PlusIcon", render: simple(PlusIcon) },
  { name: "PreviewEnvironmentIconSmall", render: simple(PreviewEnvironmentIconSmall) },
  { name: "PrivateIcon", render: simple(PrivateIcon) },
  { name: "ProdEnvironmentIcon", render: simple(ProdEnvironmentIcon) },
  { name: "ProdEnvironmentIconSmall", render: simple(ProdEnvironmentIconSmall) },
  { name: "PromoteIcon", render: simple(PromoteIcon) },
  { name: "PythonLogoIcon", render: simple(PythonLogoIcon) },
  { name: "QuestionMarkIcon", render: simple(QuestionMarkIcon) },
  { name: "QueuesIcon", render: simple(QueuesIcon) },
  { name: "RadarPulseIcon", render: simple(RadarPulseIcon) },
  { name: "RightSideMenuIcon", render: simple(RightSideMenuIcon) },
  { name: "RolesIcon", render: simple(RolesIcon) },
  { name: "RunFunctionIcon", render: simple(RunFunctionIcon) },
  { name: "RunsIcon", render: simple(RunsIcon) },
  { name: "RunsIconExtraSmall", render: simple(RunsIconExtraSmall) },
  { name: "RunsIconSmall", render: simple(RunsIconSmall) },
  { name: "SaplingIcon", render: simple(SaplingIcon) },
  { name: "ScheduleIcon", render: simple(ScheduleIcon) },
  { name: "ShieldIcon", render: simple(ShieldIcon) },
  { name: "ShieldLockIcon", render: simple(ShieldLockIcon) },
  { name: "ShowParentIcon", render: simple(ShowParentIcon) },
  { name: "ShowParentIconSelected", render: simple(ShowParentIconSelected) },
  { name: "SideMenuRightClosedIcon", render: simple(SideMenuRightClosedIcon) },
  { name: "SlackIcon", render: simple(SlackIcon) },
  { name: "SlackMonoIcon", render: simple(SlackMonoIcon) },
  { name: "SlidersIcon", render: simple(SlidersIcon) },
  { name: "SnakedArrowIcon", render: simple(SnakedArrowIcon) },
  { name: "SparkleListIcon", render: simple(SparkleListIcon) },
  { name: "StarIcon", render: simple(StarIcon) },
  { name: "StatusIcon", render: simple(StatusIcon) },
  { name: "StreamsIcon", render: simple(StreamsIcon) },
  { name: "TableIcon", render: simple(TableIcon) },
  { name: "TaskCachedIcon", render: simple(TaskCachedIcon) },
  { name: "TaskIcon", render: simple(TaskIcon) },
  { name: "TaskIconSmall", render: simple(TaskIconSmall) },
  { name: "TestTubeIcon", render: simple(TestTubeIcon) },
  { name: "TextInlineIcon", render: simple(TextInlineIcon) },
  { name: "TextWrapIcon", render: simple(TextWrapIcon) },
  { name: "TimedOutIcon", render: simple(TimedOutIcon) },
  { name: "ToggleArrowIcon", render: simple(ToggleArrowIcon) },
  { name: "TraceIcon", render: simple(TraceIcon) },
  { name: "TriggerIcon", render: simple(TriggerIcon) },
  { name: "TwoTreesIcon", render: simple(TwoTreesIcon) },
  { name: "UnarchiveIcon", render: simple(UnarchiveIcon) },
  { name: "UserCrossIcon", render: simple(UserCrossIcon) },
  { name: "UserGroupIcon", render: simple(UserGroupIcon) },
  { name: "WaitpointTokenIcon", render: simple(WaitpointTokenIcon) },
  {
    name: "WarmStartIcon",
    render: (className) => <WarmStartIcon isWarmStart={false} className={className} />,
  },
  { name: "WebhookIcon", render: simple(WebhookIcon) },
  { name: "XAIIcon", render: simple(XAIIcon) },
];

const sortedIcons = [...icons].sort((a, b) => a.name.localeCompare(b.name));

export default function Story() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="text-sm text-text-dimmed">
        {sortedIcons.length} custom icons, rendered at 24px.
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
        {sortedIcons.map((icon) => (
          <div
            key={icon.name}
            className="flex flex-col items-center gap-3 rounded-md border border-grid-bright bg-background-bright p-4 text-text-bright"
          >
            <div className="flex h-6 w-6 items-center justify-center">
              {icon.render("size-6")}
            </div>
            <div
              className="w-full truncate text-center text-xs text-text-dimmed"
              title={icon.name}
            >
              {icon.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
