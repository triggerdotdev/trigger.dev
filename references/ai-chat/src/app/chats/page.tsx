import { getChatList } from "@/app/actions";
import { redirect } from "next/navigation";

export default async function ChatsPage() {
  const chatList = await getChatList();

  if (chatList.length > 0) {
    redirect(`/chats/${chatList[0]!.id}`);
  }

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-gray-400">No conversations yet. Start a new chat.</p>
    </div>
  );
}
