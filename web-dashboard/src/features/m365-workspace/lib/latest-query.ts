export class LatestQuery {
    private versions = new Map<string, number>();
    private controllers = new Map<string, AbortController>();
    begin(resource: string) {
        this.controllers.get(resource)?.abort();
        const controller = new AbortController();
        const version = (this.versions.get(resource) || 0) + 1;
        this.versions.set(resource, version);
        this.controllers.set(resource, controller);
        return { signal: controller.signal, current: () => !controller.signal.aborted && this.versions.get(resource) === version };
    }
    dispose() { this.controllers.forEach(controller => controller.abort()); }
}
