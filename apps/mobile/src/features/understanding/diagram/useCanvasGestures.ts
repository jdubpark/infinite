import { useCallback, useEffect, useMemo, useState } from "react";
import { Animated, PanResponder, type GestureResponderEvent, type GestureResponderHandlers, type ViewStyle } from "react-native";

type CanvasSize = { contentWidth: number; contentHeight: number; frameWidth: number; frameHeight: number; frameOrigin?: Point };
type Point = { x: number; y: number };
type TouchPoint = Point & { pageX: number; pageY: number };
type GestureState = {
  mode: "pan" | "pinch" | null;
  x: number;
  y: number;
  scale: number;
  panStart: Point;
  panOrigin: Point;
  pinchStart: Point;
  pinchDistance: number;
  pinchScale: number;
  pinchOrigin: Point;
};

class GestureStateStore {
  private value: GestureState = {
    mode: null,
    x: 0,
    y: 0,
    scale: 1,
    panStart: { x: 0, y: 0 },
    panOrigin: { x: 0, y: 0 },
    pinchStart: { x: 0, y: 0 },
    pinchDistance: 0,
    pinchScale: 1,
    pinchOrigin: { x: 0, y: 0 },
  };

  read(): GestureState { return this.value; }

  update(change: Partial<GestureState>): void {
    this.value = { ...this.value, ...change };
  }
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const MOVE_THRESHOLD = 5;
const ORIGIN = { x: 0, y: 0 };

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

function touchPoints(event: GestureResponderEvent): TouchPoint[] {
  return event.nativeEvent.touches.map(touch => ({
    x: touch.pageX,
    y: touch.pageY,
    pageX: touch.pageX,
    pageY: touch.pageY,
  }));
}

function midpoint(points: TouchPoint[]): Point {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function distance(points: TouchPoint[]): number {
  if (points.length < 2) return 0;
  const dx = points[1]!.x - points[0]!.x;
  const dy = points[1]!.y - points[0]!.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function localPoint(point: Point, origin: Point): Point {
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/** One responder handles both pan and pinch, leaving short touches available to node taps. */
export function useCanvasGestures({ contentWidth, contentHeight, frameWidth, frameHeight, frameOrigin = ORIGIN }: CanvasSize): {
  panHandlers: GestureResponderHandlers;
  transform: Animated.AnimatedProps<ViewStyle>["transform"];
  scale: Animated.Value;
  reset(): void;
} {
  const [translateX] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(0));
  const [scale] = useState(() => new Animated.Value(1));
  const [state] = useState(() => new GestureStateStore());

  const fit = useCallback(() => {
    const initialScale = contentWidth > 0 && frameWidth > 0 ? Math.min(1, frameWidth / contentWidth) : 1;
    const fittedWidth = contentWidth * initialScale;
    const fittedHeight = contentHeight * initialScale;
    return {
      x: (frameWidth - fittedWidth) / 2,
      y: (frameHeight - fittedHeight) / 2,
      scale: initialScale,
    };
  }, [contentHeight, contentWidth, frameHeight, frameWidth]);

  const setTransform = useCallback((x: number, y: number, nextScale: number) => {
    state.update({ x, y, scale: nextScale });
    translateX.setValue(x);
    translateY.setValue(y);
    scale.setValue(nextScale);
  }, [scale, state, translateX, translateY]);

  const reset = useCallback(() => {
    const initial = fit();
    state.update({ mode: null });
    setTransform(initial.x, initial.y, initial.scale);
  }, [fit, setTransform, state]);

  useEffect(() => reset(), [reset]);

  const panHandlers = useMemo(() => {
    const startPan = (points: TouchPoint[], initialPoint?: Point) => {
      if (points.length === 0) return;
      const current = state.read();
      state.update({
        mode: "pan",
        panStart: initialPoint ?? { x: points[0]!.pageX, y: points[0]!.pageY },
        panOrigin: { x: current.x, y: current.y },
      });
    };

    const startPinch = (points: TouchPoint[]) => {
      if (points.length < 2) return;
      const current = state.read();
      state.update({
        mode: "pinch",
        pinchStart: localPoint(midpoint(points), frameOrigin),
        pinchDistance: Math.max(1, distance(points)),
        pinchScale: current.scale,
        pinchOrigin: { x: current.x, y: current.y },
      });
    };

    const move = (event: GestureResponderEvent) => {
      const points = touchPoints(event);
      if (points.length >= 2) {
        if (state.read().mode !== "pinch") startPinch(points);
        const center = localPoint(midpoint(points), frameOrigin);
        const current = state.read();
        const nextScale = clampScale(current.pinchScale * distance(points) / current.pinchDistance);
        const anchorX = (current.pinchStart.x - current.pinchOrigin.x) / current.pinchScale;
        const anchorY = (current.pinchStart.y - current.pinchOrigin.y) / current.pinchScale;
        setTransform(center.x - anchorX * nextScale, center.y - anchorY * nextScale, nextScale);
        return;
      }

      if (points.length === 1) {
        if (state.read().mode !== "pan") startPan(points);
        const point = points[0]!;
        const current = state.read();
        setTransform(
          current.panOrigin.x + point.pageX - current.panStart.x,
          current.panOrigin.y + point.pageY - current.panStart.y,
          current.scale,
        );
      }
    };

    const shouldMove = (event: GestureResponderEvent, gesture: { dx: number; dy: number }) =>
      event.nativeEvent.touches.length > 1 || Math.abs(gesture.dx) > MOVE_THRESHOLD || Math.abs(gesture.dy) > MOVE_THRESHOLD;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: shouldMove,
      onMoveShouldSetPanResponder: shouldMove,
      onPanResponderGrant: (event, gesture) => {
        const points = touchPoints(event);
        if (points.length >= 2) startPinch(points);
        else startPan(points, { x: gesture.x0, y: gesture.y0 });
      },
      onPanResponderMove: move,
      onPanResponderRelease: () => { state.update({ mode: null }); },
      onPanResponderTerminate: () => { state.update({ mode: null }); },
      onPanResponderTerminationRequest: () => false,
    }).panHandlers;
  }, [frameOrigin, setTransform, state]);

  const transform = useMemo<Animated.AnimatedProps<ViewStyle>["transform"]>(() => [
    { translateX },
    { translateY },
    { scale },
  ], [scale, translateX, translateY]);

  return { panHandlers, transform, scale, reset };
}
