/** Map Action inputs to `pdf-testkit upload` arguments. Pure, so it is testable. */
export function buildUploadArgs(inputs) {
    const docs = inputs.documents
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (docs.length === 0)
        throw new Error('service mode needs `documents`: one path per line');
    if (!inputs.serviceUrl)
        throw new Error('service mode needs `service-url`');
    const args = ['upload', ...docs, '--service-url', inputs.serviceUrl, '--token', inputs.serviceToken];
    if (inputs.dpi)
        args.push('--dpi', inputs.dpi);
    if (inputs.images === 'false')
        args.push('--no-images');
    // `fail-on` keeps its comment-mode meaning: the job fails at this severity.
    // Unset in service mode means "the service's check is the gate".
    if (inputs.failOn)
        args.push('--fail-on', inputs.failOn);
    if (inputs.requireService === 'true')
        args.push('--require-service');
    return args;
}
/** PROTOCOL.md §9, worded for a job log. */
export function describeExit(code) {
    switch (code) {
        case 0:
            return null;
        case 1:
            return 'pdf-testkit: a document is blocked at the configured fail-on gate.';
        case 2:
            return 'pdf-testkit: configuration error (token, repository, or an unreadable document) — see the log above.';
        case 3:
            return 'pdf-testkit: review service unavailable and require-service is set.';
        default:
            return `pdf-testkit upload exited ${code}.`;
    }
}
//# sourceMappingURL=service.js.map