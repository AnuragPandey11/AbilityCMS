/**
 * The desktop sign-in artwork with its lettering drawn live.
 *
 * The client supplied the artwork without text (`ability-cms-desktop-clean-
 * 3840x2160.jpg`) so that the words are rendered by the browser and stay sharp
 * on any screen; the image's own lettering had been an enlargement and read as
 * blurred. Everything here is placed in the artwork's design grid — 1600 x 900
 * units, the artwork's full size — through `u()`, one unit being 1/900 of the
 * window's height, which is the height the artwork is drawn at
 * (`LoginPage.css`). So the labels stay inside their panels at any window size.
 *
 * Fixed copy, nothing measured: this is the product's front door.
 */

import type { CSSProperties, ReactNode } from "react";
import logoReversed from "@/assets/brand/ability-logo-reversed.png";
import {
  BarsUpIcon,
  BellIcon,
  CloudUploadIcon,
  DatabaseIcon,
  FactoryIcon,
  GearIcon,
  MonitorChartIcon,
  ShieldCheckIcon,
  SunIcon,
  WavesIcon,
  WindIcon,
} from "@/components/layout/loginArt";

/** `n` design units, as CSS. */
function u(n: number): string {
  return `calc(${n} * var(--u))`;
}

function at(left: number, top: number, extra: CSSProperties = {}): CSSProperties {
  return { position: "absolute", left: u(left), top: u(top), ...extra };
}

// The four framed panels in the artwork: each 235 units on from the last, its
// empty lower part (y 560–670) left for the label. Colours follow the frames.
const PANELS: { name: string; lines: [string, string]; icon: ReactNode; colour: string }[] = [
  {
    name: "Solar",
    lines: ["PV Plant Monitoring,", "Performance & Forecasting"],
    icon: <SunIcon className="block h-full w-full" strokeWidth={2} />,
    colour: "#ffc93c",
  },
  {
    name: "Wind",
    lines: ["Turbine Monitoring,", "Generation & Performance"],
    icon: <WindIcon className="block h-full w-full" strokeWidth={2} />,
    colour: "#4fe08a",
  },
  {
    name: "Hydro",
    lines: ["Plant Operations,", "Water & Energy Management"],
    icon: <WavesIcon className="block h-full w-full" strokeWidth={2} />,
    colour: "#4cc8f4",
  },
  {
    name: "Industries",
    lines: ["SCADA, Automation", "& Smart Manufacturing"],
    icon: <FactoryIcon className="block h-full w-full" />,
    colour: "#ff7a3d",
  },
];
// Centred on the panel at its label height (y ~615), where its frame leans left.
const PANEL_CENTRE_X = 142;
const PANEL_STEP = 235;

const CAPABILITIES = [
  { x: 185, Icon: MonitorChartIcon },
  { x: 340, Icon: BarsUpIcon },
  { x: 470, Icon: CloudUploadIcon },
  { x: 605, Icon: BellIcon },
  { x: 730, Icon: GearIcon },
  { x: 855, Icon: DatabaseIcon },
];

const FEATURES = ["Real-time Monitoring", "Asset Management", "Forecasting", "Analytics", "O&M"];

export function LoginArtwork(): JSX.Element {
  return (
    <div className="login-art" aria-hidden="true">
      {/* A shade behind the headline, so it reads over a bright sky. */}
      <div className="login-art-shade" />

      <img
        src={logoReversed}
        alt=""
        draggable={false}
        className="select-none"
        style={at(88, 22, { height: u(88), width: "auto" })}
      />

      <div className="login-art-text flex items-center" style={at(60, 160, { height: u(70) })}>
        <span
          className="rounded-full bg-[#37d6ee] shadow-[0_0_10px_rgba(55,214,238,0.7)]"
          style={{ width: u(3), height: u(62) }}
        />
        <span
          className="font-bold leading-none tracking-tight"
          style={{ marginLeft: u(27), fontSize: u(64) }}
        >
          Ability <span className="text-[#37d6ee]">CMS</span>
        </span>
        <span className="bg-white/45" style={{ marginLeft: u(26), width: u(1.5), height: u(52) }} />
        <span className="font-semibold" style={{ marginLeft: u(24), fontSize: u(26) }}>
          Central Monitoring System
        </span>
      </div>

      <p className="login-art-text font-bold leading-none" style={at(90, 250, { fontSize: u(38) })}>
        One Platform. Multiple Industries.
      </p>

      <p className="login-art-text leading-none text-white/95" style={at(90, 306, { fontSize: u(22) })}>
        {FEATURES.map((feature, index) => (
          <span key={feature}>
            {index > 0 ? (
              <span className="text-white/60" style={{ margin: `0 ${u(14)}` }}>
                |
              </span>
            ) : null}
            {feature}
          </span>
        ))}
      </p>

      {PANELS.map((panel, index) => (
        <div
          key={panel.name}
          className="login-art-text flex flex-col items-center text-center"
          style={at(PANEL_CENTRE_X + index * PANEL_STEP - 115, 574, { width: u(230) })}
        >
          <div className="flex items-center" style={{ gap: u(10) }}>
            <span
              style={{
                width: u(30),
                height: u(30),
                color: panel.colour,
                filter: `drop-shadow(0 0 ${u(6)} ${panel.colour})`,
              }}
            >
              {panel.icon}
            </span>
            <span className="font-bold leading-none" style={{ fontSize: u(25) }}>
              {panel.name}
            </span>
          </div>
          <p className="leading-[1.4] text-white/95" style={{ marginTop: u(9), fontSize: u(13.5) }}>
            {panel.lines[0]}
            <br />
            {panel.lines[1]}
          </p>
        </div>
      ))}

      {CAPABILITIES.map(({ x, Icon }) => (
        <span
          key={x}
          className="text-[#37d6ee]"
          style={at(x - 29, 719, {
            width: u(58),
            height: u(58),
            filter: `drop-shadow(0 0 ${u(8)} rgba(55, 214, 238, 0.7))`,
          })}
        >
          <Icon className="block h-full w-full" strokeWidth={1.3} />
        </span>
      ))}
    </div>
  );
}

/** The footer strip along the bottom of the desktop page, the full window wide. */
export function LoginFooter(): JSX.Element {
  return (
    <footer className="login-footer">
      <p className="flex items-center" style={{ gap: u(12) }}>
        <span className="text-[#37d6ee]" style={{ width: u(24), height: u(24) }}>
          <ShieldCheckIcon className="block h-full w-full" strokeWidth={1.7} />
        </span>
        Powered by Ability Automation Solutions Pvt. Ltd.
      </p>
      <p className="flex items-center italic" style={{ gap: u(20) }}>
        <span className="bg-[#37d6ee]" style={{ width: u(56), height: u(1.5) }} />
        One Platform. Every Asset. Complete Visibility.
      </p>
    </footer>
  );
}
