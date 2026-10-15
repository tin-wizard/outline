import {
  InvalidHostnameError,
  RESERVED_HOST_SUFFIXES,
  validateHostname,
} from "./hostnames";

const reserved = ["app.example.net", "pages.example.net", "tin.info"];

describe("validateHostname", () => {
  it.each([
    "docs.client.com",
    "client.co.uk",
    "a-b.example.org",
    "tin.info.evil.com",
    "127.example.com",
  ])("accepts %s", (input) => {
    expect(validateHostname(input, reserved)).toEqual(input);
  });

  it("lowercases the hostname", () => {
    expect(validateHostname("Docs.Client.COM", reserved)).toEqual(
      "docs.client.com"
    );
  });

  it("accepts a sibling of a reserved host", () => {
    expect(validateHostname("other.example.net", reserved)).toEqual(
      "other.example.net"
    );
  });

  it.each([
    ["non-string", 42],
    ["undefined", undefined],
    ["empty", ""],
    ["too long", `${"a".repeat(60)}.`.repeat(4) + "b".repeat(10) + ".com"],
    ["long label", `${"a".repeat(64)}.com`],
    ["leading hyphen", "-docs.client.com"],
    ["trailing hyphen", "docs-.client.com"],
    ["underscore", "do_cs.client.com"],
    ["empty label", "docs..client.com"],
    ["single label", "client"],
    ["wildcard", "*.client.com"],
    ["trailing dot", "docs.client.com."],
    ["ipv4", "192.168.1.1"],
    ["ipv4 dotted", "1.2.3.4"],
    ["ipv4 shorthand", "127.1"],
    ["ipv4 hex shorthand", "0x7f.1"],
    ["ipv4 hex", "0x7f.0.0.1"],
    ["ipv4 octal", "017.0.0.1"],
    ["ipv4 octal dotted", "0300.0250.0.1"],
    ["ipv4 three parts", "1.2.3"],
    ["ipv4 two parts", "123.456"],
    ["ipv4 single number", "4294967295"],
    ["ipv4 single hex", "0x7f000001"],
    ["ipv6", "::1"],
    ["bracketed ipv6", "[2001:db8::1]"],
    ["localhost", "localhost"],
    ["localhost subdomain", "app.localhost"],
    [".local", "printer.local"],
    [".internal", "service.internal"],
    [".test", "site.test"],
    [".invalid", "site.invalid"],
    ["leading whitespace", " docs.client.com"],
    ["trailing whitespace", "docs.client.com\n"],
    ["url", "https://docs.client.com"],
    ["port", "docs.client.com:443"],
    ["reserved host", "app.example.net"],
    ["subdomain of reserved host", "x.pages.example.net"],
    ["reserved host differently cased", "APP.example.net"],
    ["reserved suffix", "tin.info"],
    ["subdomain of reserved suffix", "docs.tin.info"],
  ])("rejects %s", (_name, input) => {
    expect(() => validateHostname(input, reserved)).toThrow(
      InvalidHostnameError
    );
  });

  it("rejects every constant reserved suffix and its subdomains", () => {
    for (const suffix of RESERVED_HOST_SUFFIXES) {
      expect(() => validateHostname(suffix, RESERVED_HOST_SUFFIXES)).toThrow(
        InvalidHostnameError
      );
      expect(() =>
        validateHostname(`a.${suffix}`, RESERVED_HOST_SUFFIXES)
      ).toThrow(InvalidHostnameError);
    }
    expect(RESERVED_HOST_SUFFIXES).toEqual([
      "tin.info",
      "implexus.io",
      "implexusdata.com",
      "roomzz.net",
    ]);
  });

  it("does not treat a lookalike as a subdomain of a reserved host", () => {
    expect(validateHostname("nottin.info", reserved)).toEqual("nottin.info");
  });

  it("exposes the reason", () => {
    try {
      validateHostname("*.client.com", reserved);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidHostnameError);
      expect(err instanceof InvalidHostnameError && err.reason).toBeTruthy();
    }
  });
});
