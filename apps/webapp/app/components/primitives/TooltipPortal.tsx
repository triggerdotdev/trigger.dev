import type { VirtualElement as IVirtualElement } from "@popperjs/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePopper } from "react-popper";
import { useEvent } from "react-use";

// Recharts 3.x will have portal support, but until then we're using this:
//https://github.com/recharts/recharts/issues/2458#issuecomment-1063463873

// A portal only mounts once its tooltip is active, so its own mousemove listener attaches too late
// to know where the cursor already is — the tooltip would sit at {0,0} (top-left of the page) until
// the next mouse movement. Track the pointer globally so a newly-activated tooltip can seed its
// position immediately.
const lastPointer = { x: 0, y: 0 };
if (typeof window !== "undefined") {
  window.addEventListener(
    "mousemove",
    (e) => {
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
    },
    { passive: true }
  );
}

export interface PopperPortalProps {
  active?: boolean;
  children: ReactNode;
}

export default function TooltipPortal({ active = true, children }: PopperPortalProps) {
  const [portalElement, setPortalElement] = useState<HTMLDivElement>();
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>();
  const [virtualElement] = useState(() => new VirtualElement());

  const { styles, attributes, update } = usePopper(virtualElement, popperElement, POPPER_OPTIONS);

  useEffect(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setPortalElement(el);
    return () => el.remove();
  }, []);

  useEvent("mousemove", ({ clientX: x, clientY: y }) => {
    virtualElement.update(x, y);
    if (!active) return;
    update?.();
  });

  useEffect(() => {
    if (!active) return;
    // Seed from the last known pointer so the tooltip appears at the cursor immediately, even if the
    // mouse is held still after hovering onto a point (otherwise it flashes in the top-left corner).
    virtualElement.update(lastPointer.x, lastPointer.y);
    update?.();
  }, [active, update, virtualElement]);

  if (!portalElement) return null;

  return createPortal(
    <div
      ref={setPopperElement}
      {...attributes.popper}
      style={{
        ...styles.popper,
        zIndex: 1000,
        display: active ? "block" : "none",
        // The tooltip sits just under the cursor; without this, moving along the line drags the
        // cursor onto the tooltip, which fires the chart's mouseleave and flickers it off/on.
        pointerEvents: "none",
      }}
    >
      {children}
    </div>,
    portalElement
  );
}

class VirtualElement implements IVirtualElement {
  private rect = {
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  };

  update(x: number, y: number) {
    this.rect.y = y;
    this.rect.top = y;
    this.rect.bottom = y;

    this.rect.x = x;
    this.rect.left = x;
    this.rect.right = x;
  }

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}

const POPPER_OPTIONS: Parameters<typeof usePopper>[2] = {
  placement: "right-start",
  modifiers: [
    {
      name: "offset",
      options: {
        offset: [8, 8],
      },
    },
  ],
};
