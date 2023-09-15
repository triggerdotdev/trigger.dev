import gradientBackground from "~/assets/images/gradient-background.png";

export function PageGradient({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="-mt-4 h-full w-full bg-cover bg-no-repeat pt-20"
      style={{ backgroundImage: `url("${gradientBackground}")` }}
    >
      {children}
    </div>
  );
}
