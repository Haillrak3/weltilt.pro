let _fn: () => void = () => {};

export function render(): void { _fn(); }
export function setRender(fn: () => void): void { _fn = fn; }
