import type { Pt } from '../game/geometry';

export interface TapInfo {
  cx: number;
  cy: number;
  vehicleId: number | null;
  silo: boolean;
  elevator: boolean;
  parcel: number;
  fieldId: number;
}

/** What the 3D view calls on the UI layer. */
export interface ViewHost {
  attach(view: ViewControls): void;
  onTap(info: TapInfo): void;
  frame(dt: number): void;
  /** Called once when a shader fails; the host should save and reload into safe mode. */
  onGraphicsFailure?(): void;
  readonly drawMode: boolean;
  readonly draft: Pt[];
  readonly draftCells: Pt[];
  readonly draftValid: boolean;
  readonly selectedVehicle: number | null;
  readonly selectedField: number | null;
  readonly follow: boolean;
  /** True while a sheet is open beside the map (landscape), so the view shifts to stay visible. */
  readonly sideSheet?: boolean;
}

/** What the UI can ask the 3D view to do. */
export interface ViewControls {
  zoomBy(factor: number): void;
  rotateBy(radians: number): void;
  centerOnCells(x: number, y: number): void;
  /** Smoothly pan the camera to a spot. */
  panTo(x: number, y: number): void;
}
