// The top bar: the brand, the signed-in account, and the way out.
import { LogOut, UserRound } from 'lucide-react';
import { Divider, Logo } from './ui.jsx';

export function Header({ user, onAccount, onSignOut }) {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink">
          Elsewhere <span className="font-normal text-ink-3">Innkeeper</span>
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm max-w-[12rem]" onClick={onAccount}>
          <UserRound className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{user?.display_name}</span>
        </button>
        <Divider className="hidden sm:block" />
        <button type="button" className="btn btn-outline btn-sm" aria-label="Sign out" onClick={onSignOut}>
          <LogOut className="size-3.5" strokeWidth={1.75} />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
