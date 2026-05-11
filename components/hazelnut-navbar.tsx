"use client";

/**
 * Full-bleed embed of the shared 榛果繽紛樂 navbar. Lives at the bottom of
 * the marketing page; loaded as an iframe so it stays in sync with the
 * canonical asset on src.hazelnut-paradise.com.
 */
export function HazelnutNavbar() {
  return (
    <div className="relative left-1/2 mt-16 w-screen -translate-x-1/2 border-t border-border/40 bg-background/40 backdrop-blur">
      {/* Source navbar.html switches to a 300px-tall mobile layout under its
          internal @media (max-width: 910px) rule. Mirror that in the iframe
          height so nothing gets clipped or leaves a huge gap on desktop. */}
      <iframe
        src="https://src.hazelnut-paradise.com/navbar.html?content-type=text/html"
        title="榛果繽紛樂 Navbar"
        className="block w-full border-0 h-[70px] max-[910px]:h-[320px]"
        loading="lazy"
      />
    </div>
  );
}
