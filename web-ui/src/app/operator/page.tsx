import { OperatorWindow } from "@/components/operator-window";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Operator window · Wizard of Oz" };

export default function OperatorPage() {
  return <OperatorWindow />;
}
