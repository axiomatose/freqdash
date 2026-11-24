'use client';

import { Bell, KeyRound, LogOut, Settings, UserRound } from 'lucide-react';
import { useSettingsPanel } from '@/components/settings/SettingsProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogout, useSession } from '@/lib/client/queries';

/** Desktop user menu: who is signed in, settings, notifications, account and log out. (On phones: the More sheet.) */
export function UserMenu() {
  const { data } = useSession();
  const logout = useLogout();
  const settings = useSettingsPanel();
  const name = data?.name ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-44 gap-2 px-2"
          aria-label={name ? `Account menu, signed in as ${name}` : 'Account menu'}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface-2 text-muted">
            <UserRound aria-hidden className="size-3.5" />
          </span>
          <span className="truncate text-[13px] text-text">{name ?? 'Account'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>{name ? `Signed in as ${name}` : 'Signed in'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => settings.open()}>
          <Settings aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => settings.open('notifications')}>
          <Bell aria-hidden />
          Notifications
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => settings.open('account')}>
          <KeyRound aria-hidden />
          Account and sessions
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOut aria-hidden />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
