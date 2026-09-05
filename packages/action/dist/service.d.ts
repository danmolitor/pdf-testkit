/**
 * Service mode for the Action: when `service-token` is set, the Action does not
 * diff or comment itself — it runs the customer's installed `pdf-testkit upload`
 * and lets the service post the check and the comment. The CLI is invoked, not
 * bundled, because page images need pdfjs + @napi-rs/canvas from the
 * customer's node_modules, which this bundle cannot carry.
 */
export interface ServiceInputs {
    documents: string;
    serviceUrl: string;
    serviceToken: string;
    dpi: string;
    images: string;
    failOn: string;
    requireService: string;
}
/** Map Action inputs to `pdf-testkit upload` arguments. Pure, so it is testable. */
export declare function buildUploadArgs(inputs: ServiceInputs): string[];
/** PROTOCOL.md §9, worded for a job log. */
export declare function describeExit(code: number): string | null;
