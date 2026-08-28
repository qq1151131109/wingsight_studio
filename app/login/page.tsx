import { Suspense } from "react";
import LoginForm from "@/components/LoginForm";

/** 薄壳页：useSearchParams 需在 Suspense 边界内（Next 静态预渲染要求）。 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-bg text-sm text-text-3">
          加载中…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
