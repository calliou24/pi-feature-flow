import { Context, Effect, Layer } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The live pi ExtensionAPI, provided by the extension entry at activation. */
export class PiApi extends Context.Tag("PiApi")<PiApi, ExtensionAPI>() {}

export const piApiLayer = (pi: ExtensionAPI): Layer.Layer<PiApi> => Layer.succeed(PiApi, pi);

export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an external command through pi's exec, never throwing. */
export function piExec(command: string, args: string[], options: { timeout: number; cwd?: string }): Effect.Effect<ExecOutcome, never, PiApi> {
  return PiApi.pipe(
    Effect.flatMap((pi) =>
      Effect.promise(() => pi.exec(command, args, options)).pipe(
        Effect.map((result) => ({ code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" })),
        Effect.catchAll((cause) => Effect.succeed({ code: 1, stdout: "", stderr: String(cause) })),
      )
    ),
  );
}
