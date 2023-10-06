import { json } from "@sveltejs/kit";

export function GET() {
    return json({ message: "Hello from the server!" },{status:200})
}