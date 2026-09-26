export class DecodeFailure extends Error {
    info;
    constructor(info) {
        super(info.message);
        this.name = "DecodeFailure";
        this.info = info;
    }
}
export function fail(code, message, bitOffset) {
    throw new DecodeFailure({ code, message, bitOffset });
}
