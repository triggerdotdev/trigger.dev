import {
  Avatar,
  avatarIcons,
  defaultAvatarColors,
  type IconAvatar,
} from "~/components/primitives/Avatar";

// Map tablerIcons Set to Avatar array with cycling colors
const avatars: IconAvatar[] = Object.entries(avatarIcons).map(([iconName], index) => ({
  type: "icon",
  name: iconName,
  hex: defaultAvatarColors[index % defaultAvatarColors.length].hex, // Cycle through colors
}));

export default function Story() {
  return (
    <div className="flex h-full gap-12 bg-black p-12">
      {/* Left grid - size-8 */}
      <div className="flex-1">
        <h2 className="mb-4 text-lg font-semibold text-white">Size 8</h2>
        <div className="flex flex-wrap gap-2">
          {avatars.map((avatar, index) => (
            <Avatar key={`small-${index}`} avatar={avatar} size={2} orgName={`Org ${index}`} />
          ))}
        </div>
      </div>

      {/* Right grid - size-12 */}
      <div className="flex-1">
        <h2 className="mb-4 text-lg font-semibold text-white">Size 12</h2>
        <div className="flex flex-wrap gap-4">
          {avatars.map((avatar, index) => (
            <Avatar key={`large-${index}`} avatar={avatar} size={3} orgName={`Org ${index}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
