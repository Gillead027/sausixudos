import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Icon({ size = 17, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return <Icon {...props}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" /></Icon>;
}

export function MicOffIcon(props: IconProps) {
  return <Icon {...props}><path d="m4 4 16 16M9 5.5V11a3 3 0 0 0 4.8 2.4M15 10V6a3 3 0 0 0-5.1-2.1M5.5 11a6.5 6.5 0 0 0 10.8 4.9M18.5 11a6.5 6.5 0 0 1-.6 2.7M12 17.5V21M9 21h6" /></Icon>;
}

export function HeadphonesIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1v-5ZM20 14h-3v6h2a1 1 0 0 0 1-1v-5Z" /></Icon>;
}

export function HeadphonesOffIcon(props: IconProps) {
  return <Icon {...props}><path d="m4 4 16 16M5.2 8.2A8 8 0 0 1 20 12v2M4 14v-2c0-.5 0-.9.1-1.4M4 14h3v6H5a1 1 0 0 1-1-1v-5ZM17 17v3h2a1 1 0 0 0 1-1v-2" /></Icon>;
}

export function ShareIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="4" width="18" height="13" rx="1" /><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v7" /></Icon>;
}

export function VoiceIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 9v6M8 6v12M12 9v6M16 4v16M20 8v8" /></Icon>;
}

export function MessageIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 5h16v11H9l-5 4V5Z" /></Icon>;
}

export function ChevronIcon(props: IconProps) {
  return <Icon {...props}><path d="m8 10 4 4 4-4" /></Icon>;
}

export function PlusIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
}

export function SettingsIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Icon>;
}

export function LeaveIcon(props: IconProps) {
  return <Icon {...props}><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" /></Icon>;
}

export function FullscreenIcon(props: IconProps) {
  return <Icon {...props}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></Icon>;
}

export function CameraIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></Icon>;
}

export function CameraOffIcon(props: IconProps) {
  return <Icon {...props}><path d="m4 4 16 16M9 6h5.5A1.5 1.5 0 0 1 16 7.5v1.6l5-3v10l-3.2-1.92M16 15.5A1.5 1.5 0 0 1 14.5 17H4.5A1.5 1.5 0 0 1 3 15.5v-7A1.5 1.5 0 0 1 4.5 7H5" /></Icon>;
}

export function CloseIcon(props: IconProps) {
  return <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
}

export function UserIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" /></Icon>;
}

export function SpeakerIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></Icon>;
}

export function EyeIcon(props: IconProps) {
  return <Icon {...props}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function EyeOffIcon(props: IconProps) {
  return <Icon {...props}><path d="M2.5 12S6 5.5 12 5.5c1.6 0 3 .4 4.2 1M21.5 12S18 18.5 12 18.5c-1.6 0-3-.4-4.2-1" /><path d="M4 4l16 16M9.5 9.7A3 3 0 0 0 14.3 14.5" /></Icon>;
}

export function SearchIcon(props: IconProps) {
  return <Icon {...props}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Icon>;
}

export function ImageIcon(props: IconProps) {
  return <Icon {...props}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="m21 15-5-5-11 11" /></Icon>;
}

export function PaletteIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><circle cx="8.5" cy="10" r="1.3" fill="currentColor" /><circle cx="12" cy="8" r="1.3" fill="currentColor" /><circle cx="15.5" cy="10" r="1.3" fill="currentColor" /><path d="M12 21a1.6 1.6 0 0 1 0-9c2 0 3-1 3-2.5S14 7 12 7" /></Icon>;
}

export function MusicNoteIcon(props: IconProps) {
  return <Icon {...props}><path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></Icon>;
}

export function GameControllerIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="7.5" width="19" height="10" rx="5" /><path d="M7 10.5v4M5 12.5h4" /><circle cx="16" cy="10.5" r="1" fill="currentColor" /><circle cx="18.5" cy="13" r="1" fill="currentColor" /></Icon>;
}

export function EditIcon(props: IconProps) {
  return <Icon {...props}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
}

export function TrashIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></Icon>;
}

export function CopyIcon(props: IconProps) {
  return <Icon {...props}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Icon>;
}

export function CheckIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 12.5 9.5 18 20 6" /></Icon>;
}

export function SmileIcon(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M8.5 13.5c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2" /><circle cx="9" cy="9.5" r="1" fill="currentColor" /><circle cx="15" cy="9.5" r="1" fill="currentColor" /></Icon>;
}
