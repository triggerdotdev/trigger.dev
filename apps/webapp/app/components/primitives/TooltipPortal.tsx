import type { VirtualElement as IVirtualElement } from "@popperjs/core";
import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePopper } from "react-popper";
import { useEvent } from "react-use";
import useLazyRef from "~/hooks/useLazyRef";

// Recharts 3.x will have portal support, but until then we're using this:
//https://github.com/recharts/recharts/issues/2458#issuecomment-1063463873

export interface PopperPortalProps {
  active?: boolean;
  children: ReactNode;
}

export default function TooltipPortal({ active = true, children }: PopperPortalProps) {
  const [portalElement, setPortalElement] = useState<HTMLDivElement>();
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>();
  const virtualElementRef = useLazyRef(() => new VirtualElement());

  const { styles, attributes, update } = usePopper(
    virtualElementRef.current,
    popperElement,
    POPPER_OPTIONS
  );

  useEffect(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    setPortalElement(el);
    return () => el.remove();
  }, []);

  useEvent("mousemove", ({ clientX: x, clientY: y }) => {
    virtualElementRef.current?.update(x, y);
    if (!active) return;
    update?.();
  });

  useEffect(() => {
    if (!active) return;
    update?.();
  }, [active, update]);

  if (!portalElement) return null;

  return createPortal(
    <div
      ref={setPopperElement}
      {...attributes.popper}
      style={{
        ...styles.popper,
        zIndex: 1000,
        display: active ? "block" : "none",
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
